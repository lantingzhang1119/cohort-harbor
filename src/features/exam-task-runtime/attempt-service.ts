import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  AssignmentStatus,
  AttemptStatus,
  QuestionBankQuestionType,
  SubmissionReason,
} from "@/generated/prisma/enums";
import { parseSnapshotQuestions } from "@/features/exam-tasks/dto";
import { ExamTaskRuntimeError } from "@/features/exam-task-runtime/errors";
import { scoreTaskResponses } from "@/features/exam-task-runtime/scoring";
import type {
  SafeTaskQuestion,
  StoredSnapshotQuestion,
  TaskAnswerResponse,
} from "@/features/exam-task-runtime/types";

type Db = PrismaClient;

const attemptInclude = {
  answers: true,
  assignment: {
    include: {
      task: { include: { snapshot: true } },
    },
  },
} satisfies Prisma.ExamTaskAttemptInclude;

type LoadedAttempt = Prisma.ExamTaskAttemptGetPayload<{ include: typeof attemptInclude }>;

function storedQuestions(attempt: LoadedAttempt): StoredSnapshotQuestion[] {
  return parseSnapshotQuestions(attempt.assignment.task.snapshot.questions);
}

function safeQuestion(question: StoredSnapshotQuestion): SafeTaskQuestion {
  return {
    id: question.id,
    sequence: question.sequence,
    type: question.type,
    prompt: question.prompt,
    score: question.score,
    options: question.options
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ id, label, text }) => ({ id, label, text })),
    blankCount: question.blanks.length,
  };
}

function asTaskResponse(value: Prisma.JsonValue): TaskAnswerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { selectedOptionIds: [] };
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.values)) {
    return { values: record.values.map((item) => String(item)) };
  }
  return {
    selectedOptionIds: Array.isArray(record.selectedOptionIds)
      ? record.selectedOptionIds.map((item) => String(item))
      : [],
  };
}

function publicAttempt(attempt: LoadedAttempt) {
  return {
    attemptId: attempt.id,
    assignmentId: attempt.assignmentId,
    taskName: attempt.assignment.task.name,
    startsAt: attempt.assignment.task.startsAt,
    endsAt: attempt.assignment.task.endsAt,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    status: attempt.status,
    score: attempt.score,
    passed: attempt.passed,
    questions: storedQuestions(attempt)
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map(safeQuestion),
    answers: Object.fromEntries(
      attempt.answers.map((answer) => [answer.questionId, asTaskResponse(answer.response)]),
    ),
  };
}

function assertWindow(startsAt: Date, endsAt: Date, now: Date): void {
  if (now < startsAt) {
    throw new ExamTaskRuntimeError("考试尚未开始", "NOT_STARTED");
  }
  if (now >= endsAt) {
    throw new ExamTaskRuntimeError("考试任务已结束", "TASK_ENDED");
  }
}

function normalizeResponse(
  question: StoredSnapshotQuestion,
  raw: unknown,
): TaskAnswerResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExamTaskRuntimeError("答案格式无效", "INVALID_ANSWER");
  }
  const value = raw as Record<string, unknown>;
  if (question.type === QuestionBankQuestionType.FILL_BLANK) {
    if (!Array.isArray(value.values) || value.values.some((item) => typeof item !== "string")) {
      throw new ExamTaskRuntimeError("填空题答案格式无效", "INVALID_ANSWER");
    }
    if (value.values.length > question.blanks.length) {
      throw new ExamTaskRuntimeError("填空题答案数量无效", "INVALID_ANSWER");
    }
    const values = value.values as string[];
    return {
      values: Array.from(
        { length: question.blanks.length },
        (_, index) => String(values[index] ?? "").slice(0, 1000),
      ),
    };
  }
  if (
    !Array.isArray(value.selectedOptionIds) ||
    value.selectedOptionIds.some((item) => typeof item !== "string")
  ) {
    throw new ExamTaskRuntimeError("选择题答案格式无效", "INVALID_ANSWER");
  }
  const selected = [...new Set(value.selectedOptionIds as string[])];
  const validIds = new Set(question.options.map((option) => option.id));
  if (selected.some((id) => !validIds.has(id))) {
    throw new ExamTaskRuntimeError("答案包含无效选项", "INVALID_ANSWER");
  }
  if (question.type === QuestionBankQuestionType.SINGLE_CHOICE && selected.length > 1) {
    throw new ExamTaskRuntimeError("单选题只能选择一个答案", "INVALID_ANSWER");
  }
  return { selectedOptionIds: selected.sort() };
}

async function loadAttempt(
  db: Pick<PrismaClient, "examTaskAttempt">,
  attemptId: string,
): Promise<LoadedAttempt> {
  const attempt = await db.examTaskAttempt.findUnique({
    where: { id: attemptId },
    include: attemptInclude,
  });
  if (!attempt) throw new ExamTaskRuntimeError("考试记录不存在", "ATTEMPT_NOT_FOUND");
  return attempt;
}

export async function startTaskAttempt(
  db: Db,
  assignmentId: string,
  userId: string,
  now = new Date(),
) {
  const assignment = await db.examTaskAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      task: { include: { snapshot: true } },
      attempts: { orderBy: { attemptNo: "desc" } },
    },
  });
  if (!assignment) throw new ExamTaskRuntimeError("考试任务不存在", "ASSIGNMENT_NOT_FOUND");
  if (assignment.userId !== userId) {
    throw new ExamTaskRuntimeError("无权访问该考试任务", "FORBIDDEN");
  }

  const active = assignment.attempts.find((attempt) => attempt.status === AttemptStatus.IN_PROGRESS);
  if (active && now >= assignment.task.endsAt) {
    await submitTaskAttempt(db, active.id, userId, now, SubmissionReason.TIMEOUT);
    throw new ExamTaskRuntimeError("考试任务已结束，答案已自动提交", "TASK_ENDED");
  }
  assertWindow(assignment.task.startsAt, assignment.task.endsAt, now);
  if (active) return getTaskAttemptForUser(db, active.id, userId, now);
  if (
    assignment.status !== AssignmentStatus.NOT_STARTED &&
    assignment.status !== AssignmentStatus.RETAKE_READY
  ) {
    throw new ExamTaskRuntimeError("当前任务状态不能开始考试", "NO_ATTEMPTS_LEFT");
  }

  const attemptNo = assignment.currentAttemptCount + 1;
  let created: { id: string };
  try {
    created = await db.$transaction(async (transaction) => {
      const claimed = await transaction.examTaskAssignment.updateMany({
        where: {
          id: assignmentId,
          userId,
          currentAttemptCount: assignment.currentAttemptCount,
          status: assignment.status,
        },
        data: {
          currentAttemptCount: { increment: 1 },
          status: AssignmentStatus.IN_PROGRESS,
          startedAt: assignment.startedAt ?? now,
        },
      });
      if (claimed.count !== 1) {
        throw new ExamTaskRuntimeError("考试正在其他窗口启动", "INVALID_STATE");
      }
      return transaction.examTaskAttempt.create({
        data: {
          assignmentId,
          attemptNo,
          startedAt: now,
          expiresAt: assignment.task.endsAt,
        },
        select: { id: true },
      });
    });
  } catch (error) {
    if (error instanceof ExamTaskRuntimeError && error.code === "INVALID_STATE") {
      const concurrent = await db.examTaskAttempt.findFirst({
        where: { assignmentId, status: AttemptStatus.IN_PROGRESS },
        orderBy: { attemptNo: "desc" },
        select: { id: true },
      });
      if (concurrent) return getTaskAttemptForUser(db, concurrent.id, userId, now);
    }
    throw error;
  }
  return getTaskAttemptForUser(db, created.id, userId, now);
}

export async function getTaskAttemptForUser(
  db: Db,
  attemptId: string,
  userId: string,
  now = new Date(),
) {
  const attempt = await loadAttempt(db, attemptId);
  if (attempt.assignment.userId !== userId) {
    throw new ExamTaskRuntimeError("无权访问该考试", "FORBIDDEN");
  }
  if (attempt.status === AttemptStatus.IN_PROGRESS && now >= attempt.assignment.task.endsAt) {
    await submitTaskAttempt(db, attemptId, userId, now, SubmissionReason.TIMEOUT);
    throw new ExamTaskRuntimeError("考试已到期并自动提交", "ATTEMPT_CLOSED");
  }
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw new ExamTaskRuntimeError("考试已经提交", "ATTEMPT_CLOSED");
  }
  if (attempt.status === AttemptStatus.IN_PROGRESS && now < attempt.assignment.task.startsAt) {
    throw new ExamTaskRuntimeError("考试尚未开始", "NOT_STARTED");
  }
  return publicAttempt(attempt);
}

export async function saveTaskAnswer(
  db: Db,
  attemptId: string,
  userId: string,
  questionId: string,
  response: unknown,
  now = new Date(),
) {
  const attempt = await loadAttempt(db, attemptId);
  if (attempt.assignment.userId !== userId) {
    throw new ExamTaskRuntimeError("无权保存该考试答案", "FORBIDDEN");
  }
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw new ExamTaskRuntimeError("考试已经提交，不能继续保存", "ATTEMPT_CLOSED");
  }
  if (now >= attempt.assignment.task.endsAt) {
    await submitTaskAttempt(db, attemptId, userId, now, SubmissionReason.TIMEOUT);
    throw new ExamTaskRuntimeError("考试已到期并自动提交", "ATTEMPT_CLOSED");
  }
  assertWindow(attempt.assignment.task.startsAt, attempt.assignment.task.endsAt, now);
  const question = storedQuestions(attempt).find((item) => item.id === questionId);
  if (!question) throw new ExamTaskRuntimeError("题目不属于本次考试", "INVALID_ANSWER");
  const normalized = normalizeResponse(question, response);
  const answer = await db.$transaction(async (transaction) => {
    const claimed = await transaction.examTaskAttempt.updateMany({
      where: { id: attemptId, status: AttemptStatus.IN_PROGRESS },
      data: { status: AttemptStatus.IN_PROGRESS },
    });
    if (claimed.count !== 1) {
      throw new ExamTaskRuntimeError("考试已经提交，不能继续保存", "ATTEMPT_CLOSED");
    }
    return transaction.examTaskAnswer.upsert({
      where: { attemptId_questionId: { attemptId, questionId } },
      create: { attemptId, questionId, response: normalized as Prisma.InputJsonValue },
      update: { response: normalized as Prisma.InputJsonValue },
    });
  });
  return { questionId: answer.questionId, response: asTaskResponse(answer.response), savedAt: answer.savedAt };
}

export async function submitTaskAttempt(
  db: Db,
  attemptId: string,
  userId: string,
  now = new Date(),
  requestedReason?: SubmissionReason,
) {
  const attempt = await loadAttempt(db, attemptId);
  if (attempt.assignment.userId !== userId) {
    throw new ExamTaskRuntimeError("无权提交该考试", "FORBIDDEN");
  }
  return submitLoadedTaskAttempt(db, attempt, now, requestedReason);
}

export async function submitLoadedTaskAttempt(
  db: Db,
  attempt: LoadedAttempt,
  now: Date,
  requestedReason?: SubmissionReason,
) {
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    return {
      score: attempt.score ?? 0,
      passed: attempt.passed ?? false,
      status: attempt.status,
      replayed: true,
    };
  }
  if (now < attempt.assignment.task.startsAt) {
    throw new ExamTaskRuntimeError("考试尚未开始", "NOT_STARTED");
  }
  const finalized = await db.$transaction(async (transaction) => {
    const claimed = await transaction.examTaskAttempt.updateMany({
      where: { id: attempt.id, status: AttemptStatus.IN_PROGRESS },
      data: { status: AttemptStatus.IN_PROGRESS },
    });
    if (claimed.count !== 1) return null;

    const currentAttempt = await loadAttempt(transaction, attempt.id);
    const reason = requestedReason ??
      (now >= currentAttempt.assignment.task.endsAt
        ? SubmissionReason.TIMEOUT
        : SubmissionReason.MANUAL);
    const questions = storedQuestions(currentAttempt);
    const responses = Object.fromEntries(
      currentAttempt.answers.map((answer) => [answer.questionId, asTaskResponse(answer.response)]),
    );
    const scored = scoreTaskResponses(
      questions,
      responses,
      currentAttempt.assignment.task.passingScore,
    );
    const attemptStatus = reason === SubmissionReason.TIMEOUT
      ? AttemptStatus.EXPIRED
      : AttemptStatus.SUBMITTED;
    const canRetakeBeforeDeadline = now < currentAttempt.assignment.task.endsAt;
    const assignmentStatus = scored.passed
      ? AssignmentStatus.PASSED
      : !canRetakeBeforeDeadline
        ? AssignmentStatus.FAILED
        : currentAttempt.attemptNo === 1
          ? AssignmentStatus.RETAKE_READY
          : AssignmentStatus.APPLICATION_REQUIRED;

    for (const answer of currentAttempt.answers) {
      await transaction.examTaskAnswer.update({
        where: { id: answer.id },
        data: { awardedScore: scored.awarded[answer.questionId] ?? 0 },
      });
    }
    await transaction.examTaskAttempt.update({
      where: { id: currentAttempt.id },
      data: {
        status: attemptStatus,
        submittedAt: now,
        elapsedSeconds: Math.max(
          0,
          Math.min(
            Math.floor((now.getTime() - currentAttempt.startedAt.getTime()) / 1000),
            Math.floor(
              (currentAttempt.expiresAt.getTime() - currentAttempt.startedAt.getTime()) / 1000,
            ),
          ),
        ),
        score: scored.score,
        passed: scored.passed,
        submissionReason: reason,
      },
    });
    await transaction.examTaskAssignment.update({
      where: { id: currentAttempt.assignmentId },
      data: {
        status: assignmentStatus,
        score: scored.score,
        passed: scored.passed,
        submittedAt: now,
        ...(now >= currentAttempt.assignment.task.endsAt ? { processedAt: now } : {}),
      },
    });
    return { score: scored.score, passed: scored.passed, status: attemptStatus };
  });
  if (!finalized) {
    const replay = await loadAttempt(db, attempt.id);
    return {
      score: replay.score ?? 0,
      passed: replay.passed ?? false,
      status: replay.status,
      replayed: true,
    };
  }
  return { ...finalized, replayed: false };
}

export async function loadTaskAttemptForMaintenance(db: Db, attemptId: string) {
  return loadAttempt(db, attemptId);
}

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  AssignmentStatus,
  AttemptStatus,
  SubmissionReason,
} from "@/generated/prisma/enums";
import { ensureAssignment } from "@/features/exams/assignment-service";
import { scoreAnswers } from "@/features/exams/scoring";

export { ensureAssignment };

export class AttemptServiceError extends Error {
  constructor(
    public readonly code:
      | "ASSIGNMENT_NOT_FOUND"
      | "FORBIDDEN"
      | "NO_ATTEMPTS_LEFT"
      | "ATTEMPT_NOT_FOUND"
      | "ATTEMPT_EXPIRED"
      | "INVALID_ANSWER",
    message: string,
  ) {
    super(message);
    this.name = "AttemptServiceError";
  }
}

function shuffled<T>(values: T[], random: () => number) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.max(
      0,
      Math.min(index, Math.floor(random() * (index + 1))),
    );
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

type AttemptWithQuestions = Prisma.ExamAttemptGetPayload<{
  include: {
    questions: true;
    assignment: { include: { exam: true } };
  };
}>;

function publicPayload(attempt: AttemptWithQuestions) {
  return {
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    questions: attempt.questions
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((question) => ({
        questionId: question.questionId,
        displayOrder: question.displayOrder,
        prompt: question.promptSnapshot,
        type: question.typeSnapshot,
        score: question.scoreSnapshot,
        options: question.optionSnapshot as Array<{ key: string; text: string }>,
      })),
  };
}

export async function startAttempt(
  db: PrismaClient,
  assignmentId: string,
  userId: string,
  options: { now?: Date; random?: () => number } = {},
) {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const assignment = await db.examAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      exam: {
        include: {
          questions: {
            where: { enabled: true },
            orderBy: { sequence: "asc" },
            include: { options: { orderBy: { sortOrder: "asc" } } },
          },
        },
      },
      attempts: { orderBy: { attemptNo: "desc" } },
    },
  });
  if (!assignment) throw new AttemptServiceError("ASSIGNMENT_NOT_FOUND", "考试任务不存在");
  if (assignment.userId !== userId) throw new AttemptServiceError("FORBIDDEN", "无权访问该考试任务");
  const active = assignment.attempts.find(
    (attempt) => attempt.status === AttemptStatus.IN_PROGRESS,
  );
  if (active && active.expiresAt > now) {
    const loaded = await db.examAttempt.findUniqueOrThrow({
      where: { id: active.id },
      include: { questions: true, assignment: { include: { exam: true } } },
    });
    return publicPayload(loaded);
  }
  if (active && active.expiresAt <= now) {
    await submitAttempt(db, active.id, userId, {
      now,
      reason: SubmissionReason.TIMEOUT,
    });
  }
  const nextAttemptNo = (assignment.attempts[0]?.attemptNo ?? 0) + 1;
  if (nextAttemptNo > assignment.allowedAttempts) {
    throw new AttemptServiceError("NO_ATTEMPTS_LEFT", "当前没有可用考试次数");
  }
  const expiresAt = new Date(now.getTime() + assignment.exam.durationMinutes * 60 * 1000);
  const questions = assignment.exam.randomizeQuestions
    ? shuffled(assignment.exam.questions, random)
    : assignment.exam.questions;
  const attempt = await db.$transaction(async (transaction) => {
    const created = await transaction.examAttempt.create({
      data: {
        assignmentId,
        attemptNo: nextAttemptNo,
        startedAt: now,
        expiresAt,
      },
    });
    for (const [index, question] of questions.entries()) {
      const optionOrder = assignment.exam.randomizeOptions
        ? shuffled(question.options, random)
        : question.options;
      await transaction.attemptQuestion.create({
        data: {
          attemptId: created.id,
          questionId: question.id,
          displayOrder: index + 1,
          promptSnapshot: question.prompt,
          typeSnapshot: question.type,
          scoreSnapshot: question.score,
          optionSnapshot: optionOrder.map((option) => ({
            key: option.optionKey,
            text: option.text,
          })) as Prisma.InputJsonValue,
          correctOptionKeys: question.options
            .filter((option) => option.isCorrect)
            .map((option) => option.optionKey) as Prisma.InputJsonValue,
        },
      });
    }
    await transaction.examAssignment.update({
      where: { id: assignmentId },
      data: { status: AssignmentStatus.IN_PROGRESS },
    });
    return transaction.examAttempt.findUniqueOrThrow({
      where: { id: created.id },
      include: { questions: true, assignment: { include: { exam: true } } },
    });
  });
  return publicPayload(attempt);
}

export async function saveAnswer(
  db: PrismaClient,
  attemptId: string,
  userId: string,
  questionId: string,
  selectedKeys: string[],
  now = new Date(),
) {
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    include: {
      assignment: true,
      questions: { where: { questionId } },
    },
  });
  if (!attempt) throw new AttemptServiceError("ATTEMPT_NOT_FOUND", "考试记录不存在");
  if (attempt.assignment.userId !== userId) throw new AttemptServiceError("FORBIDDEN", "无权保存该考试答案");
  if (attempt.status !== AttemptStatus.IN_PROGRESS || attempt.expiresAt <= now) {
    if (attempt.status === AttemptStatus.IN_PROGRESS) {
      await submitAttempt(db, attempt.id, userId, { now, reason: SubmissionReason.TIMEOUT });
    }
    throw new AttemptServiceError("ATTEMPT_EXPIRED", "考试已结束，不能继续作答");
  }
  const snapshot = attempt.questions[0];
  if (!snapshot) throw new AttemptServiceError("INVALID_ANSWER", "题目不属于本次考试");
  const validKeys = new Set(
    (snapshot.optionSnapshot as Array<{ key: string }>).map((option) => option.key),
  );
  const normalized = [...new Set(selectedKeys.map((key) => key.toUpperCase()))].sort();
  if (normalized.some((key) => !validKeys.has(key))) {
    throw new AttemptServiceError("INVALID_ANSWER", "答案选项无效");
  }
  const answer = await db.attemptAnswer.upsert({
    where: { attemptId_questionId: { attemptId, questionId } },
    create: { attemptId, questionId, selectedKeys: normalized },
    update: { selectedKeys: normalized },
  });
  return { ...answer, selectedKeys: answer.selectedKeys as string[] };
}

export async function submitAttempt(
  db: PrismaClient,
  attemptId: string,
  userId: string,
  options: { now?: Date; reason?: SubmissionReason } = {},
) {
  const now = options.now ?? new Date();
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    include: {
      assignment: { include: { exam: true } },
      questions: true,
      answers: true,
    },
  });
  if (!attempt) throw new AttemptServiceError("ATTEMPT_NOT_FOUND", "考试记录不存在");
  if (attempt.assignment.userId !== userId) throw new AttemptServiceError("FORBIDDEN", "无权提交该考试");
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    return { score: attempt.score ?? 0, passed: attempt.passed ?? false, status: attempt.status };
  }
  const answers = Object.fromEntries(
    attempt.answers.map((answer) => [answer.questionId, answer.selectedKeys as string[]]),
  );
  const scored = scoreAnswers(
    attempt.questions.map((question) => ({
      questionId: question.questionId,
      score: question.scoreSnapshot,
      correctKeys: question.correctOptionKeys as string[],
    })),
    answers,
    attempt.assignment.exam.passingScore,
  );
  const reason =
    options.reason ??
    (now >= attempt.expiresAt ? SubmissionReason.TIMEOUT : SubmissionReason.MANUAL);
  const status = reason === SubmissionReason.TIMEOUT ? AttemptStatus.EXPIRED : AttemptStatus.SUBMITTED;
  await db.$transaction(async (transaction) => {
    for (const answer of attempt.answers) {
      await transaction.attemptAnswer.update({
        where: { id: answer.id },
        data: { awardedScore: scored.awarded[answer.questionId] ?? 0 },
      });
    }
    await transaction.examAttempt.update({
      where: { id: attempt.id },
      data: {
        status,
        submittedAt: now,
        elapsedSeconds: Math.max(
          0,
          Math.min(
            Math.floor((now.getTime() - attempt.startedAt.getTime()) / 1000),
            Math.floor((attempt.expiresAt.getTime() - attempt.startedAt.getTime()) / 1000),
          ),
        ),
        score: scored.score,
        passed: scored.passed,
        submissionReason: reason,
      },
    });
    const nextAssignmentData = scored.passed
      ? { status: AssignmentStatus.PASSED }
      : attempt.attemptNo === 1
        ? {
            status: AssignmentStatus.RETAKE_READY,
            allowedAttempts: Math.max(2, attempt.assignment.allowedAttempts),
          }
        : { status: AssignmentStatus.APPLICATION_REQUIRED };
    await transaction.examAssignment.update({
      where: { id: attempt.assignmentId },
      data: nextAssignmentData,
    });
  });
  return { score: scored.score, passed: scored.passed, status };
}

export async function expireAttempt(
  db: PrismaClient,
  attemptId: string,
  userId: string,
  now = new Date(),
) {
  return submitAttempt(db, attemptId, userId, {
    now,
    reason: SubmissionReason.TIMEOUT,
  });
}

export async function getAttemptForUser(
  db: PrismaClient,
  attemptId: string,
  userId: string,
) {
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: true,
      answers: true,
      assignment: { include: { exam: true } },
    },
  });
  if (!attempt) throw new AttemptServiceError("ATTEMPT_NOT_FOUND", "考试记录不存在");
  if (attempt.assignment.userId !== userId) throw new AttemptServiceError("FORBIDDEN", "无权访问该考试");
  return {
    ...publicPayload(attempt),
    status: attempt.status,
    score: attempt.score,
    passed: attempt.passed,
    answers: Object.fromEntries(
      attempt.answers.map((answer) => [answer.questionId, answer.selectedKeys as string[]]),
    ),
  };
}

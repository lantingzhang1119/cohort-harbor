import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ExamTaskStatus,
  NotificationType,
} from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import type { AdminExamTaskDto } from "@/features/exam-tasks/dto";
import { ExamTaskError } from "@/features/exam-tasks/errors";
import { resolveAssigneeSelection } from "@/features/exam-tasks/employee-selection";
import { requireExamTaskAdmin } from "@/features/exam-tasks/permissions";
import {
  publishExamTaskSchema,
  type PublishExamTaskInput,
} from "@/features/exam-tasks/schemas";
import { buildExamPaperSnapshotPayload } from "@/features/exam-tasks/snapshot-builder";

type Db = PrismaClient;

function validationMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "issues" in error &&
    Array.isArray((error as { issues: Array<{ message?: string }> }).issues)
  ) {
    return (
      (error as { issues: Array<{ message?: string }> }).issues[0]?.message ??
      "发布参数无效"
    );
  }
  return "发布参数无效";
}

function toAdminTaskDto(
  task: {
    id: string;
    name: string;
    description: string | null;
    questionBankId: string;
    snapshotId: string;
    startsAt: Date;
    endsAt: Date;
    passingScore: number;
    status: ExamTaskStatus;
    publishedAt: Date;
    snapshot: {
      questionBankName: string;
      questionBankVersion: number;
      questionCount: number;
      totalScore: number;
    };
    _count: { assignments: number };
  },
  replayed: boolean,
): AdminExamTaskDto {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    questionBankId: task.questionBankId,
    snapshotId: task.snapshotId,
    startsAt: task.startsAt.toISOString(),
    endsAt: task.endsAt.toISOString(),
    passingScore: task.passingScore,
    status: task.status,
    publishedAt: task.publishedAt.toISOString(),
    assignmentCount: task._count.assignments,
    questionBankName: task.snapshot.questionBankName,
    questionBankVersion: task.snapshot.questionBankVersion,
    questionCount: task.snapshot.questionCount,
    totalScore: task.snapshot.totalScore,
    replayed,
  };
}

function normalizedDescription(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function assertReplayMatches(
  task: {
    name: string;
    description: string | null;
    questionBankId: string;
    startsAt: Date;
    endsAt: Date;
    passingScore: number;
    publishedById: string | null;
  },
  input: PublishExamTaskInput,
  actorId: string,
): void {
  const matches =
    task.publishedById === actorId &&
    task.name === input.name &&
    task.description === normalizedDescription(input.description) &&
    task.questionBankId === input.questionBankId &&
    task.startsAt.getTime() === input.startsAt.getTime() &&
    task.endsAt.getTime() === input.endsAt.getTime() &&
    task.passingScore === input.passingScore;
  if (!matches) {
    throw new ExamTaskError(
      "该幂等键已用于另一项发布请求，请刷新页面后重新提交",
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

const taskDetailInclude = {
  snapshot: {
    select: {
      questionBankName: true,
      questionBankVersion: true,
      questionCount: true,
      totalScore: true,
    },
  },
  _count: { select: { assignments: true } },
} satisfies Prisma.ExamTaskInclude;

async function loadTaskDetail(db: Db | Prisma.TransactionClient, taskId: string) {
  return db.examTask.findUniqueOrThrow({
    where: { id: taskId },
    include: taskDetailInclude,
  });
}

export async function publishExamTask(
  db: Db,
  rawInput: PublishExamTaskInput,
  actorId: string,
): Promise<AdminExamTaskDto> {
  let input: PublishExamTaskInput;
  try {
    input = publishExamTaskSchema.parse(rawInput);
  } catch (error) {
    throw new ExamTaskError(validationMessage(error), "VALIDATION_ERROR");
  }

  // The service boundary must authorize before returning an idempotent replay.
  await requireExamTaskAdmin(db, actorId);

  const existing = await db.examTask.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: taskDetailInclude,
  });
  if (existing) {
    assertReplayMatches(existing, input, actorId);
    return toAdminTaskDto(existing, true);
  }

  return db.$transaction(async (transaction) => {
    const replay = await transaction.examTask.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: taskDetailInclude,
    });
    if (replay) {
      assertReplayMatches(replay, input, actorId);
      return toAdminTaskDto(replay, true);
    }

    const { snapshot: publisherSnapshot } = await requireExamTaskAdmin(
      transaction,
      actorId,
    );

    const paper = await buildExamPaperSnapshotPayload(
      transaction,
      input.questionBankId,
      input.passingScore,
    );
    const assignees = await resolveAssigneeSelection(transaction, input.selection);

    const snapshot = await transaction.examPaperSnapshot.create({
      data: {
        questionBankId: paper.questionBankId,
        questionBankVersion: paper.questionBankVersion,
        questionBankName: paper.questionBankName,
        questions: paper.questions,
        questionCount: paper.questionCount,
        totalScore: paper.totalScore,
        passingScore: paper.passingScore,
      },
    });

    const task = await transaction.examTask.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        description: normalizedDescription(input.description),
        questionBankId: paper.questionBankId,
        snapshotId: snapshot.id,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        passingScore: input.passingScore,
        status: ExamTaskStatus.PUBLISHED,
        publishedById: actorId,
        publishedBySnapshot: publisherSnapshot,
      },
    });

    await transaction.examTaskAssignment.createMany({
      data: assignees.map((assignee) => ({
        taskId: task.id,
        userId: assignee.id,
      })),
    });

    const assignments = await transaction.examTaskAssignment.findMany({
      where: { taskId: task.id },
      select: { id: true, userId: true },
    });

    const endsLabel = input.endsAt.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    });
    await transaction.notification.createMany({
      data: assignments.map((assignment) => ({
        userId: assignment.userId,
        type: NotificationType.EXAM_TASK_PUBLISHED,
        title: `新考试任务：${input.name}`,
        body: `请在 ${endsLabel}（上海时区）前完成考试「${input.name}」。`,
        href: `/employee/exam?assignmentId=${assignment.id}`,
        examTaskAssignmentId: assignment.id,
        dedupeKey: `exam-task-published:${task.id}:${assignment.userId}`,
      })),
    });

    await writeAuditLog(transaction, {
      actorId,
      action: "EXAM_TASK_PUBLISH",
      targetType: "EXAM_TASK",
      targetId: task.id,
      result: "SUCCESS",
      metadata: {
        name: task.name,
        questionBankId: paper.questionBankId,
        snapshotId: snapshot.id,
        assignmentCount: assignments.length,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const detail = await loadTaskDetail(transaction, task.id);
    return toAdminTaskDto(detail, false);
  });
}

export async function getExamTaskById(db: Db, taskId: string): Promise<AdminExamTaskDto | null> {
  const task = await db.examTask.findUnique({
    where: { id: taskId },
    include: taskDetailInclude,
  });
  if (!task) return null;
  return toAdminTaskDto(task, false);
}

import type { PrismaClient } from "@/generated/prisma/client";
import {
  AssignmentStatus,
  AttemptStatus,
  ExamTaskStatus,
  NotificationType,
  SubmissionReason,
} from "@/generated/prisma/enums";
import {
  loadTaskAttemptForMaintenance,
  submitLoadedTaskAttempt,
} from "@/features/exam-task-runtime/attempt-service";

const HOUR_MS = 60 * 60 * 1000;
const actionableStatuses = [
  AssignmentStatus.NOT_STARTED,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.RETAKE_READY,
];

export async function processExpiredExamTasks(
  db: PrismaClient,
  now = new Date(),
  userId?: string,
) {
  const assignments = await db.examTaskAssignment.findMany({
    where: {
      ...(userId ? { userId } : {}),
      task: { status: ExamTaskStatus.PUBLISHED, endsAt: { lte: now } },
      processedAt: null,
    },
    include: {
      task: { select: { endsAt: true } },
      attempts: {
        where: { status: AttemptStatus.IN_PROGRESS },
        orderBy: { attemptNo: "desc" },
        take: 1,
      },
    },
  });
  let submitted = 0;
  let overdue = 0;
  for (const assignment of assignments) {
    const active = assignment.attempts[0];
    if (active) {
      const loaded = await loadTaskAttemptForMaintenance(db, active.id);
      const result = await submitLoadedTaskAttempt(db, loaded, now, SubmissionReason.TIMEOUT);
      if (!result.replayed) submitted += 1;
      continue;
    }
    const changed = await db.examTaskAssignment.updateMany({
      where: {
        id: assignment.id,
        status: AssignmentStatus.NOT_STARTED,
        processedAt: null,
      },
      data: {
        status: AssignmentStatus.OVERDUE,
        expiredAt: assignment.task.endsAt,
        processedAt: now,
      },
    });
    overdue += changed.count;
    if (changed.count === 0) {
      const shouldFail =
        assignment.status === AssignmentStatus.IN_PROGRESS ||
        assignment.status === AssignmentStatus.RETAKE_READY ||
        assignment.status === AssignmentStatus.APPLICATION_REQUIRED ||
        assignment.status === AssignmentStatus.PENDING_APPROVAL;
      await db.examTaskAssignment.updateMany({
        where: { id: assignment.id, processedAt: null },
        data: {
          ...(shouldFail ? { status: AssignmentStatus.FAILED, passed: false } : {}),
          processedAt: now,
        },
      });
    }
  }

  if (!userId) {
    await db.examTask.updateMany({
      where: { status: ExamTaskStatus.PUBLISHED, endsAt: { lte: now } },
      data: { status: ExamTaskStatus.CLOSED },
    });
  }
  return { inspected: assignments.length, submitted, overdue };
}

type ReminderNode = {
  type: NotificationType;
  label: string;
  thresholdHours: number;
  lowerBoundHours: number;
};

const reminderNodes: ReminderNode[] = [
  {
    type: NotificationType.EXAM_DUE_24H,
    label: "24 小时",
    thresholdHours: 24,
    lowerBoundHours: 2,
  },
  {
    type: NotificationType.EXAM_DUE_2H,
    label: "2 小时",
    thresholdHours: 2,
    lowerBoundHours: 0,
  },
];

export async function generateExamTaskReminders(
  db: PrismaClient,
  now = new Date(),
  userId?: string,
) {
  const assignments = await db.examTaskAssignment.findMany({
    where: {
      ...(userId ? { userId } : {}),
      status: { in: actionableStatuses },
      task: {
        status: ExamTaskStatus.PUBLISHED,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    },
    include: { task: true },
  });
  let created = 0;
  for (const assignment of assignments) {
    const durationHours =
      (assignment.task.endsAt.getTime() - assignment.task.startsAt.getTime()) / HOUR_MS;
    const remainingHours = (assignment.task.endsAt.getTime() - now.getTime()) / HOUR_MS;
    for (const node of reminderNodes) {
      if (durationHours < node.thresholdHours || remainingHours > node.thresholdHours) continue;
      if (remainingHours <= node.lowerBoundHours) continue;
      const dedupeKey = `exam-task-due-${node.thresholdHours}h:${assignment.id}`;
      const exists = await db.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (exists) continue;
      try {
        await db.notification.create({
          data: {
            userId: assignment.userId,
            type: node.type,
            title: `考试将在${node.label}内截止`,
            body: `考试「${assignment.task.name}」截止时间为 ${assignment.task.endsAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。`,
            href: `/employee/exam?assignmentId=${assignment.id}`,
            examTaskAssignmentId: assignment.id,
            dedupeKey,
          },
        });
        created += 1;
      } catch (error) {
        const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
        if (!duplicate) throw error;
      }
    }
  }
  return { inspected: assignments.length, created };
}

export async function runExamTaskMaintenance(db: PrismaClient, now = new Date()) {
  const expired = await processExpiredExamTasks(db, now);
  const reminders = await generateExamTaskReminders(db, now);
  return { expired, reminders };
}

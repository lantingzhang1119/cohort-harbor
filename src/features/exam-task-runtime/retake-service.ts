import type { PrismaClient } from "@/generated/prisma/client";
import {
  AssignmentStatus,
  NotificationType,
  RetakeStatus,
} from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { requireExamTaskAdmin } from "@/features/exam-tasks/permissions";
import { ExamTaskRuntimeError } from "@/features/exam-task-runtime/errors";

export async function applyForTaskRetake(
  db: PrismaClient,
  assignmentId: string,
  requesterId: string,
  reason: string,
  now = new Date(),
) {
  if (reason.trim().length < 10) {
    throw new ExamTaskRuntimeError("补考原因至少需要 10 个字符", "INVALID_ANSWER");
  }
  const assignment = await db.examTaskAssignment.findUnique({
    where: { id: assignmentId },
    include: { task: true },
  });
  if (!assignment) throw new ExamTaskRuntimeError("考试任务不存在", "ASSIGNMENT_NOT_FOUND");
  if (assignment.userId !== requesterId) {
    throw new ExamTaskRuntimeError("无权申请该任务补考", "FORBIDDEN");
  }
  if (assignment.status !== AssignmentStatus.APPLICATION_REQUIRED) {
    throw new ExamTaskRuntimeError("当前考试状态不能申请补考", "INVALID_STATE");
  }
  if (now >= assignment.task.endsAt) {
    throw new ExamTaskRuntimeError("考试任务已结束，不能再申请本任务补考", "TASK_ENDED");
  }

  return db.$transaction(async (transaction) => {
    const pending = await transaction.examTaskRetakeApplication.findFirst({
      where: { assignmentId, requesterId, status: RetakeStatus.PENDING },
    });
    if (pending) throw new ExamTaskRuntimeError("已有待审批的补考申请", "INVALID_STATE");
    const claimed = await transaction.examTaskAssignment.updateMany({
      where: { id: assignmentId, userId: requesterId, status: AssignmentStatus.APPLICATION_REQUIRED },
      data: { status: AssignmentStatus.PENDING_APPROVAL },
    });
    if (claimed.count !== 1) {
      throw new ExamTaskRuntimeError("补考状态已变化，请刷新", "INVALID_STATE");
    }
    return transaction.examTaskRetakeApplication.create({
      data: { assignmentId, requesterId, reason: reason.trim() },
    });
  });
}

export async function listPendingTaskRetakes(db: PrismaClient, actorId: string) {
  await requireExamTaskAdmin(db, actorId);
  return db.examTaskRetakeApplication.findMany({
    where: { status: RetakeStatus.PENDING },
    include: {
      assignment: { include: { task: { select: { id: true, name: true, endsAt: true } } } },
      requester: {
        select: { id: true, employeeNo: true, name: true, firstDepartment: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function reviewTaskRetake(
  db: PrismaClient,
  applicationId: string,
  reviewerId: string,
  input: { approve: boolean; note?: string },
  now = new Date(),
) {
  await requireExamTaskAdmin(db, reviewerId);
  const application = await db.examTaskRetakeApplication.findUnique({
    where: { id: applicationId },
    include: { assignment: { include: { task: true } } },
  });
  if (!application || application.status !== RetakeStatus.PENDING) {
    throw new ExamTaskRuntimeError("补考申请不存在或已处理", "INVALID_STATE");
  }
  if (input.approve && now >= application.assignment.task.endsAt) {
    throw new ExamTaskRuntimeError("考试任务已结束，不能批准新的答题机会", "TASK_ENDED");
  }

  return db.$transaction(async (transaction) => {
    const reviewer = await transaction.user.findUniqueOrThrow({
      where: { id: reviewerId },
      select: { id: true, employeeNo: true, name: true, email: true, role: true },
    });
    const status = input.approve ? RetakeStatus.APPROVED : RetakeStatus.REJECTED;
    const claimed = await transaction.examTaskRetakeApplication.updateMany({
      where: { id: applicationId, status: RetakeStatus.PENDING },
      data: {
        status,
        reviewerId,
        reviewerSnapshot: snapshotUserIdentity(reviewer),
        reviewNote: input.note?.trim() || null,
        reviewedAt: now,
      },
    });
    if (claimed.count !== 1) {
      throw new ExamTaskRuntimeError("补考申请已由其他管理员处理", "INVALID_STATE");
    }
    await transaction.examTaskAssignment.update({
      where: { id: application.assignmentId },
      data: {
        status: input.approve
          ? AssignmentStatus.RETAKE_READY
          : AssignmentStatus.APPLICATION_REQUIRED,
      },
    });
    await transaction.notification.create({
      data: {
        userId: application.requesterId,
        type: input.approve ? NotificationType.RETAKE_APPROVED : NotificationType.RETAKE_REJECTED,
        title: input.approve ? "补考申请已通过" : "补考申请未通过",
        body: input.approve
          ? `考试「${application.assignment.task.name}」已获得一次新的答题机会。`
          : input.note?.trim() || "请复习后再次申请。",
        href: `/employee/exam?assignmentId=${application.assignmentId}`,
        examTaskAssignmentId: application.assignmentId,
        dedupeKey: `exam-task-retake-${status.toLowerCase()}:${application.id}`,
      },
    });
    await writeAuditLog(transaction, {
      actorId: reviewerId,
      action: "EXAM_TASK_RETAKE_REVIEW",
      targetType: "EXAM_TASK_RETAKE_APPLICATION",
      targetId: application.id,
      result: "SUCCESS",
      metadata: { status, assignmentId: application.assignmentId },
    });
    return transaction.examTaskRetakeApplication.findUniqueOrThrow({
      where: { id: application.id },
    });
  });
}

import type { PrismaClient } from "@/generated/prisma/client";
import {
  AssignmentStatus,
  NotificationType,
  RetakeStatus,
} from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";

export class RetakeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetakeServiceError";
  }
}

export async function transitionAfterFailedAttempt(
  db: PrismaClient,
  assignmentId: string,
  attemptNo: number,
) {
  const assignment = await db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
  if (attemptNo === 1) {
    return db.examAssignment.update({
      where: { id: assignmentId },
      data: {
        status: AssignmentStatus.RETAKE_READY,
        allowedAttempts: Math.max(2, assignment.allowedAttempts),
      },
    });
  }
  return db.examAssignment.update({
    where: { id: assignmentId },
    data: { status: AssignmentStatus.APPLICATION_REQUIRED },
  });
}

export async function applyForRetake(
  db: PrismaClient,
  assignmentId: string,
  requesterId: string,
  reason: string,
) {
  if (reason.trim().length < 10) throw new RetakeServiceError("补考原因至少需要 10 个字符");
  const assignment = await db.examAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment || assignment.userId !== requesterId) throw new RetakeServiceError("考试任务不存在");
  if (assignment.status !== AssignmentStatus.APPLICATION_REQUIRED) {
    throw new RetakeServiceError("当前考试状态不能申请补考");
  }
  const pending = await db.retakeApplication.findFirst({
    where: { assignmentId, requesterId, status: RetakeStatus.PENDING },
  });
  if (pending) throw new RetakeServiceError("已有待审批的补考申请");
  return db.$transaction(async (transaction) => {
    const application = await transaction.retakeApplication.create({
      data: { assignmentId, requesterId, reason: reason.trim() },
    });
    await transaction.examAssignment.update({
      where: { id: assignmentId },
      data: { status: AssignmentStatus.PENDING_APPROVAL },
    });
    return application;
  });
}

export async function reviewRetake(
  db: PrismaClient,
  applicationId: string,
  reviewerId: string,
  input: { approve: boolean; note?: string },
) {
  const application = await db.retakeApplication.findUnique({
    where: { id: applicationId },
    include: { assignment: true },
  });
  if (!application || application.status !== RetakeStatus.PENDING) {
    throw new RetakeServiceError("补考申请不存在或已处理");
  }
  return db.$transaction(async (transaction) => {
    const reviewer = await transaction.user.findUniqueOrThrow({
      where: { id: reviewerId },
      select: { id: true, employeeNo: true, name: true, email: true, role: true },
    });
    const status = input.approve ? RetakeStatus.APPROVED : RetakeStatus.REJECTED;
    const reviewed = await transaction.retakeApplication.update({
      where: { id: application.id },
      data: {
        status,
        reviewerId,
        reviewerSnapshot: snapshotUserIdentity(reviewer),
        reviewNote: input.note?.trim() || null,
        reviewedAt: new Date(),
      },
    });
    await transaction.examAssignment.update({
      where: { id: application.assignmentId },
      data: input.approve
        ? {
            status: AssignmentStatus.RETAKE_READY,
            allowedAttempts: application.assignment.allowedAttempts + 1,
          }
        : { status: AssignmentStatus.APPLICATION_REQUIRED },
    });
    await transaction.notification.create({
      data: {
        userId: application.requesterId,
        type: input.approve
          ? NotificationType.RETAKE_APPROVED
          : NotificationType.RETAKE_REJECTED,
        title: input.approve ? "补考申请已通过" : "补考申请未通过",
        body: input.approve
          ? "你已获得一次新的考试机会，请在任务页开始补考。"
          : input.note?.trim() || "请复习后再次申请。",
      },
    });
    await writeAuditLog(transaction, {
      actorId: reviewerId,
      action: "RETAKE_REVIEW",
      targetType: "RETAKE_APPLICATION",
      targetId: application.id,
      result: "SUCCESS",
      metadata: { status },
    });
    return reviewed;
  });
}

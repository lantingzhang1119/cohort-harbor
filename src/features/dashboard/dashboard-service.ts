import type { PrismaClient } from "@/generated/prisma/client";
import { AssignmentStatus, PolicyStatus, Role, WorkLocation } from "@/generated/prisma/enums";
import {
  generateExamTaskReminders,
  processExpiredExamTasks,
} from "@/features/exam-task-runtime/maintenance-service";

const assignmentStatuses = Object.values(AssignmentStatus);

export async function getAdminDashboard(db: PrismaClient) {
  const [
    total,
    enabled,
    disabled,
    unsetLocation,
    groupedStatuses,
    taskGroupedStatuses,
    pendingRetakes,
    pendingTaskRetakes,
    recentImports,
  ] =
    await Promise.all([
      db.user.count({ where: { role: Role.EMPLOYEE } }),
      db.user.count({ where: { role: Role.EMPLOYEE, enabled: true } }),
      db.user.count({ where: { role: Role.EMPLOYEE, enabled: false } }),
      db.user.count({ where: { role: Role.EMPLOYEE, workLocation: WorkLocation.UNSET } }),
      db.examAssignment.groupBy({ by: ["status"], _count: { _all: true } }),
      db.examTaskAssignment.groupBy({ by: ["status"], _count: { _all: true } }),
      db.retakeApplication.count({ where: { status: "PENDING" } }),
      db.examTaskRetakeApplication.count({ where: { status: "PENDING" } }),
      db.rosterImportBatch.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          sourceName: true,
          originalFileName: true,
          status: true,
          totalRows: true,
          createdCount: true,
          updatedCount: true,
          skippedCount: true,
          conflictCount: true,
          errorCount: true,
          createdAt: true,
          committedAt: true,
        },
      }),
    ]);

  const examStatuses = Object.fromEntries(
    assignmentStatuses.map((status) => [status, 0]),
  ) as Record<AssignmentStatus, number>;
  for (const row of groupedStatuses) examStatuses[row.status] = row._count._all;
  for (const row of taskGroupedStatuses) examStatuses[row.status] += row._count._all;
  const assignmentTotal = Object.values(examStatuses).reduce((sum, count) => sum + count, 0);

  return {
    employees: { total, enabled, disabled, unsetLocation },
    examStatuses,
    passRate: assignmentTotal === 0 ? 0 : Math.round((examStatuses.PASSED / assignmentTotal) * 100),
    pendingRetakes: pendingRetakes + pendingTaskRetakes,
    recentImports,
  };
}

export async function getEmployeeDashboard(db: PrismaClient, userId: string) {
  const now = new Date();
  await processExpiredExamTasks(db, now, userId);
  await generateExamTaskReminders(db, now, userId);
  const [profile, assignment, taskAssignment, unreadNotifications, guideCount, publishedPolicies, viewedVersions] =
    await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          name: true,
          employeeNo: true,
          workLocation: true,
          firstDepartment: true,
          secondDepartment: true,
          position: true,
          hiredAt: true,
        },
      }),
      db.examAssignment.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          dueAt: true,
          allowedAttempts: true,
          exam: { select: { name: true, passingScore: true, durationMinutes: true } },
          attempts: {
            orderBy: { attemptNo: "desc" },
            take: 1,
            select: { attemptNo: true, score: true, passed: true },
          },
        },
      }),
      db.examTaskAssignment.findFirst({
        where: { userId },
        orderBy: [{ task: { endsAt: "desc" } }, { createdAt: "desc" }],
        select: {
          id: true,
          status: true,
          task: {
            select: {
              name: true,
              startsAt: true,
              endsAt: true,
              passingScore: true,
            },
          },
          attempts: {
            orderBy: { attemptNo: "desc" },
            take: 1,
            select: { attemptNo: true, score: true, passed: true },
          },
        },
      }),
      db.notification.count({ where: { userId, readAt: null } }),
      db.cityGuide.count({ where: { enabled: true } }),
      db.policy.count({ where: { status: PolicyStatus.PUBLISHED } }),
      db.policyViewLog.groupBy({ by: ["policyVersionId"], where: { userId } }),
    ]);

  return {
    profile,
    assignment: taskAssignment
      ? {
          id: taskAssignment.id,
          status: taskAssignment.status,
          dueAt: taskAssignment.task.endsAt,
          startsAt: taskAssignment.task.startsAt,
          allowedAttempts: 2,
          examName: taskAssignment.task.name,
          passingScore: taskAssignment.task.passingScore,
          durationMinutes: Math.max(
            1,
            Math.round(
              (taskAssignment.task.endsAt.getTime() - taskAssignment.task.startsAt.getTime()) /
                60_000,
            ),
          ),
          latestAttempt: taskAssignment.attempts[0] ?? null,
          source: "TASK" as const,
        }
      : assignment
      ? {
          id: assignment.id,
          status: assignment.status,
          dueAt: assignment.dueAt,
          allowedAttempts: assignment.allowedAttempts,
          examName: assignment.exam.name,
          passingScore: assignment.exam.passingScore,
          durationMinutes: assignment.exam.durationMinutes,
          latestAttempt: assignment.attempts[0] ?? null,
          source: "LEGACY" as const,
        }
      : null,
    unreadNotifications,
    guideCount,
    publishedPolicies,
    viewedPolicies: viewedVersions.length,
  };
}

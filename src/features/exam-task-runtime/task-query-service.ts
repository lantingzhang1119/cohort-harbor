import type { PrismaClient } from "@/generated/prisma/client";
import { AssignmentStatus, AttemptStatus } from "@/generated/prisma/enums";
import {
  generateExamTaskReminders,
  processExpiredExamTasks,
} from "@/features/exam-task-runtime/maintenance-service";

export type EmployeeTaskDisplayStatus =
  | "UPCOMING"
  | "PENDING"
  | "IN_PROGRESS"
  | "PASSED"
  | "FAILED"
  | "RETAKE_READY"
  | "APPLICATION_REQUIRED"
  | "PENDING_APPROVAL"
  | "OVERDUE";

function displayStatus(
  status: AssignmentStatus,
  startsAt: Date,
  now: Date,
): EmployeeTaskDisplayStatus {
  if (status === AssignmentStatus.NOT_STARTED) return now < startsAt ? "UPCOMING" : "PENDING";
  if (status === AssignmentStatus.IN_PROGRESS) return "IN_PROGRESS";
  if (status === AssignmentStatus.PASSED) return "PASSED";
  if (status === AssignmentStatus.RETAKE_READY) return "RETAKE_READY";
  if (status === AssignmentStatus.APPLICATION_REQUIRED) return "APPLICATION_REQUIRED";
  if (status === AssignmentStatus.PENDING_APPROVAL) return "PENDING_APPROVAL";
  if (status === AssignmentStatus.OVERDUE) return "OVERDUE";
  return "FAILED";
}

export async function listExamTasksForEmployee(
  db: PrismaClient,
  userId: string,
  now = new Date(),
) {
  await processExpiredExamTasks(db, now, userId);
  await generateExamTaskReminders(db, now, userId);
  const assignments = await db.examTaskAssignment.findMany({
    where: { userId },
    include: {
      task: {
        include: {
          snapshot: {
            select: {
              questionBankName: true,
              questionBankVersion: true,
              questionCount: true,
              totalScore: true,
            },
          },
        },
      },
      attempts: { orderBy: { attemptNo: "desc" }, take: 1 },
      retakeApplications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ task: { endsAt: "asc" } }, { createdAt: "desc" }],
  });
  return assignments.map((assignment) => {
    const latestAttempt = assignment.attempts[0] ?? null;
    return {
      id: assignment.id,
      status: assignment.status,
      displayStatus: displayStatus(assignment.status, assignment.task.startsAt, now),
      currentAttemptCount: assignment.currentAttemptCount,
      score: assignment.score,
      passed: assignment.passed,
      startedAt: assignment.startedAt,
      submittedAt: assignment.submittedAt,
      expiredAt: assignment.expiredAt,
      task: {
        id: assignment.task.id,
        name: assignment.task.name,
        description: assignment.task.description,
        startsAt: assignment.task.startsAt,
        endsAt: assignment.task.endsAt,
        passingScore: assignment.task.passingScore,
        questionBankName: assignment.task.snapshot.questionBankName,
        questionBankVersion: assignment.task.snapshot.questionBankVersion,
        questionCount: assignment.task.snapshot.questionCount,
        totalScore: assignment.task.snapshot.totalScore,
      },
      latestAttempt: latestAttempt
        ? {
            id: latestAttempt.id,
            attemptNo: latestAttempt.attemptNo,
            status: latestAttempt.status,
            score: latestAttempt.score,
            passed: latestAttempt.passed,
            canContinue: latestAttempt.status === AttemptStatus.IN_PROGRESS,
          }
        : null,
      latestRetakeApplication: assignment.retakeApplications[0] ?? null,
    };
  });
}

import type { PrismaClient } from "@/generated/prisma/client";

import { processExpiredExamTasks } from "@/features/exam-task-runtime/maintenance-service";

export async function listExamTaskResultsForEmployee(
  db: PrismaClient,
  userId: string,
  now = new Date(),
) {
  await processExpiredExamTasks(db, now, userId);
  const assignments = await db.examTaskAssignment.findMany({
    where: { userId, currentAttemptCount: { gt: 0 } },
    include: {
      task: {
        include: {
          snapshot: {
            select: { questionBankName: true, questionBankVersion: true },
          },
        },
      },
      attempts: { orderBy: { attemptNo: "desc" } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return assignments.map((assignment) => ({
    id: assignment.id,
    status: assignment.status,
    task: {
      id: assignment.task.id,
      name: assignment.task.name,
      passingScore: assignment.task.passingScore,
      questionBankName: assignment.task.snapshot.questionBankName,
      questionBankVersion: assignment.task.snapshot.questionBankVersion,
    },
    attempts: assignment.attempts.map((attempt) => ({
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      submittedAt: attempt.submittedAt,
      elapsedSeconds: attempt.elapsedSeconds,
      score: attempt.score,
      passed: attempt.passed,
      submissionReason: attempt.submissionReason,
    })),
  }));
}

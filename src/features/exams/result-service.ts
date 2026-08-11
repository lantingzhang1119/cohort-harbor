import type { PrismaClient } from "@/generated/prisma/client";

export async function listExamResultsForUser(db: PrismaClient, userId: string) {
  const assignments = await db.examAssignment.findMany({
    where: { userId },
    include: {
      exam: true,
      attempts: {
        orderBy: { attemptNo: "desc" },
        include: {
          questions: { orderBy: { displayOrder: "asc" } },
          answers: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return assignments.map((assignment) => ({
    id: assignment.id,
    status: assignment.status,
    dueAt: assignment.dueAt,
    exam: {
      id: assignment.exam.id,
      name: assignment.exam.name,
      passingScore: assignment.exam.passingScore,
    },
    attempts: assignment.attempts.map((attempt) => {
      const answerMap = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
      const wrongAnswers = assignment.exam.showWrongAnswers && attempt.submittedAt
        ? attempt.questions.flatMap((question) => {
            const answer = answerMap.get(question.questionId);
            if ((answer?.awardedScore ?? 0) >= question.scoreSnapshot) return [];
            return [{
              questionId: question.questionId,
              displayOrder: question.displayOrder,
              prompt: question.promptSnapshot,
              type: question.typeSnapshot,
              score: question.scoreSnapshot,
              options: question.optionSnapshot as Array<{ key: string; text: string }>,
              selectedKeys: (answer?.selectedKeys as string[] | undefined) ?? [],
              correctKeys: question.correctOptionKeys as string[],
            }];
          })
        : undefined;
      return {
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
        ...(wrongAnswers === undefined ? {} : { wrongAnswers }),
      };
    }),
  }));
}

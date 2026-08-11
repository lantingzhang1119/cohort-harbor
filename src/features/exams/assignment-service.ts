import type { PrismaClient } from "@/generated/prisma/client";

export async function findEnabledExamAssignment(
  db: PrismaClient,
  userId: string,
) {
  return db.examAssignment.findFirst({
    where: {
      userId,
      exam: { enabled: true },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function ensureAssignment(
  db: PrismaClient,
  userId: string,
  examId: string,
  now = new Date(),
) {
  const existing = await db.examAssignment.findUnique({
    where: { userId_examId: { userId, examId } },
  });
  if (existing) return existing;
  const [user, exam] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { hiredAt: true } }),
    db.exam.findUniqueOrThrow({ where: { id: examId } }),
  ]);
  const basis = user.hiredAt ?? now;
  const dueAt = new Date(basis.getTime() + exam.dueDaysAfterHire * 24 * 60 * 60 * 1000);
  return db.examAssignment.create({ data: { userId, examId, dueAt } });
}

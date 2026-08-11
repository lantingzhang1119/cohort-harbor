import type { Prisma, PrismaClient } from "@/generated/prisma/client";

type AuditClient = Pick<PrismaClient, "auditLog" | "user"> | Prisma.TransactionClient;

export type AuditEntry = {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  metadata?: Prisma.InputJsonValue;
};

export async function writeAuditLog(db: AuditClient, entry: AuditEntry) {
  const actor = entry.actorId
    ? await db.user.findUnique({
        where: { id: entry.actorId },
        select: { id: true, employeeNo: true, name: true, email: true, role: true },
      })
    : null;
  return db.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      actorSnapshot: actor
        ? {
            id: actor.id,
            employeeNo: actor.employeeNo,
            name: actor.name,
            role: actor.role,
          }
        : undefined,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      result: entry.result,
      metadata: entry.metadata,
    },
  });
}

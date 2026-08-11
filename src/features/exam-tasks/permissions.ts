import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { AuthError } from "@/features/auth/errors";

type PermissionDb = Pick<PrismaClient, "user"> | Prisma.TransactionClient;

export async function requireExamTaskAdmin(db: PermissionDb, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN) {
    throw new AuthError("FORBIDDEN", 403);
  }
  return { actor, snapshot: snapshotUserIdentity(actor) };
}

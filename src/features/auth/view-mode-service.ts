import type { PrismaClient } from "@/generated/prisma/client";
import { Role, SessionViewMode, UserStatus } from "@/generated/prisma/enums";
import { AuthError } from "@/features/auth/errors";
import { requireSession } from "@/features/auth/guards";
import { requiresRealNameBeforeEmployeeView } from "@/features/auth/real-name";
import { hashSessionToken } from "@/features/auth/session";

export async function switchSessionViewMode(
  db: PrismaClient,
  token: string | undefined,
  targetMode: SessionViewMode,
): Promise<{ redirectTo: "/admin" | "/employee" }> {
  const session = await requireSession(db, token);
  if (
    targetMode === SessionViewMode.EMPLOYEE &&
    requiresRealNameBeforeEmployeeView(session.user)
  ) {
    throw new AuthError("REAL_NAME_REQUIRED", 409);
  }
  const now = new Date();
  const allowedRoles = targetMode === SessionViewMode.ADMIN
    ? [Role.ADMIN, Role.SUPER_ADMIN]
    : [Role.EMPLOYEE, Role.ADMIN, Role.SUPER_ADMIN];
  const updated = await db.session.updateMany({
    where: {
      id: session.id,
      tokenHash: hashSessionToken(token!),
      userId: session.userId,
      revokedAt: null,
      expiresAt: { gt: now },
      user: {
        enabled: true,
        status: UserStatus.ACTIVE,
        role: { in: allowedRoles },
      },
    },
    data: { viewMode: targetMode },
  });

  if (updated.count !== 1) {
    const current = await db.session.findUnique({
      where: { tokenHash: hashSessionToken(token!) },
      include: { user: true },
    });
    if (
      !current ||
      current.id !== session.id ||
      current.userId !== session.userId ||
      current.revokedAt ||
      current.expiresAt <= new Date() ||
      !current.user.enabled ||
      current.user.status !== UserStatus.ACTIVE
    ) {
      throw new AuthError("UNAUTHENTICATED", 401);
    }
    if (
      targetMode === SessionViewMode.ADMIN &&
      current.user.role !== Role.ADMIN &&
      current.user.role !== Role.SUPER_ADMIN
    ) {
      throw new AuthError("FORBIDDEN", 403);
    }
    throw new AuthError("UNAUTHENTICATED", 401);
  }

  return {
    redirectTo: targetMode === SessionViewMode.ADMIN ? "/admin" : "/employee",
  };
}

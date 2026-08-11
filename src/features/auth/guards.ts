import type { PrismaClient, User } from "@/generated/prisma/client";
import { Role, SessionViewMode } from "@/generated/prisma/enums";

import { AuthError } from "@/features/auth/errors";
import { getActiveSession } from "@/features/auth/session";

export type AuthContext = { user: User };
type ViewAuthContext = AuthContext & { viewMode: SessionViewMode };

export async function requireSession(
  db: PrismaClient,
  token: string | undefined,
  now = new Date(),
) {
  const session = await requireSessionForPasswordChange(db, token, now);
  if (session.user.mustChangePassword) {
    throw new AuthError("PASSWORD_CHANGE_REQUIRED", 403);
  }
  return session;
}

export async function requireSessionForPasswordChange(
  db: PrismaClient,
  token: string | undefined,
  now = new Date(),
) {
  const session = await getActiveSession(db, token, now);
  if (!session) throw new AuthError("UNAUTHENTICATED", 401);
  return session;
}

export function requireAdmin(context: ViewAuthContext): User {
  return requireAdminAccess(context);
}

export function requireEmployee(context: AuthContext): User {
  if (context.user.role !== Role.EMPLOYEE) throw new AuthError("FORBIDDEN", 403);
  return context.user;
}

export function requireAdminAccess(context: ViewAuthContext): User {
  if (
    context.viewMode !== SessionViewMode.ADMIN ||
    (context.user.role !== Role.SUPER_ADMIN && context.user.role !== Role.ADMIN)
  ) {
    throw new AuthError("FORBIDDEN", 403);
  }
  return context.user;
}

export function requireSuperAdmin(context: ViewAuthContext): User {
  if (
    context.viewMode !== SessionViewMode.ADMIN ||
    context.user.role !== Role.SUPER_ADMIN
  ) {
    throw new AuthError("FORBIDDEN", 403);
  }
  return context.user;
}

export function requireEmployeeViewAccess(
  context: AuthContext & { viewMode: SessionViewMode },
): User {
  if (context.viewMode !== SessionViewMode.EMPLOYEE) {
    throw new AuthError("FORBIDDEN", 403);
  }
  return context.user;
}

export function assertOwnResource(context: AuthContext, ownerId: string): void {
  if (context.user.id !== ownerId) throw new AuthError("FORBIDDEN", 403);
}

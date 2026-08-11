import type { PrismaClient } from "@/generated/prisma/client";
import { Role, SessionViewMode, UserStatus } from "@/generated/prisma/enums";

import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { verifyPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";

type LoginInput = { identifier: string; password: string };

type LoginDependencies = {
  db: PrismaClient;
  now?: () => Date;
  maxFailures?: number;
  lockMinutes?: number;
  sessionTtlHours?: number;
  afterPasswordRejected?: () => Promise<void>;
  afterPasswordVerified?: () => Promise<void>;
};

export async function login(input: LoginInput, dependencies: LoginDependencies) {
  const identifier = input.identifier.trim();
  const now = dependencies.now?.() ?? new Date();
  const maxFailures = dependencies.maxFailures ?? 5;
  const lockMinutes = dependencies.lockMinutes ?? 15;

  let user = await dependencies.db.user.findUnique({ where: { employeeNo: identifier } });
  if (!user) {
    const matchingNames = await dependencies.db.user.findMany({
      where: { name: identifier },
      take: 2,
    });
    if (matchingNames.length > 1) {
      await writeAuditLog(dependencies.db, {
        action: "AUTH_LOGIN",
        result: "DENIED",
        metadata: { reason: "AMBIGUOUS_IDENTIFIER", identifierType: "NAME" },
      });
      throw new AuthError("AMBIGUOUS_IDENTIFIER", 400);
    }
    user = matchingNames[0] ?? null;
  }

  if (!user || !user.enabled || user.status !== "ACTIVE") {
    await writeAuditLog(dependencies.db, {
      actorId: user?.id,
      action: "AUTH_LOGIN",
      targetType: user ? "USER" : undefined,
      targetId: user?.id,
      result: "DENIED",
      metadata: { reason: "INVALID_CREDENTIALS" },
    });
    throw new AuthError("INVALID_CREDENTIALS", 401);
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await writeAuditLog(dependencies.db, {
      actorId: user.id,
      action: "AUTH_LOGIN",
      targetType: "USER",
      targetId: user.id,
      result: "DENIED",
      metadata: { reason: "ACCOUNT_LOCKED" },
    });
    throw new AuthError("ACCOUNT_LOCKED", 423);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    await dependencies.afterPasswordRejected?.();

    const failure = await dependencies.db.$transaction(async (transaction) => {
      const expiredLockClaim = await transaction.user.updateMany({
        where: {
          id: user.id,
          passwordHash: user.passwordHash,
          enabled: true,
          status: UserStatus.ACTIVE,
          lockedUntil: { lte: now },
        },
        data: { failedLoginCount: 1, lockedUntil: null },
      });
      const claimed =
        expiredLockClaim.count === 1
          ? expiredLockClaim
          : await transaction.user.updateMany({
              where: {
                id: user.id,
                passwordHash: user.passwordHash,
                enabled: true,
                status: UserStatus.ACTIVE,
                lockedUntil: null,
              },
              data: { failedLoginCount: { increment: 1 } },
            });

      if (claimed.count !== 1) {
        const current = await transaction.user.findUnique({ where: { id: user.id } });
        const isLocked = Boolean(
          current &&
            current.passwordHash === user.passwordHash &&
            current.enabled &&
            current.status === UserStatus.ACTIVE &&
            current.lockedUntil &&
            current.lockedUntil > now,
        );
        await writeAuditLog(transaction, {
          actorId: current?.id,
          action: "AUTH_LOGIN",
          targetType: current ? "USER" : undefined,
          targetId: current?.id,
          result: "DENIED",
          metadata: { reason: isLocked ? "ACCOUNT_LOCKED" : "STALE_CREDENTIALS" },
        });
        return isLocked
          ? { code: "ACCOUNT_LOCKED" as const, status: 423 }
          : { code: "INVALID_CREDENTIALS" as const, status: 401 };
      }

      const updatedUser = await transaction.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      const lockedUntil =
        updatedUser.failedLoginCount >= maxFailures
          ? new Date(now.getTime() + lockMinutes * 60 * 1000)
          : null;
      if (lockedUntil || updatedUser.lockedUntil) {
        await transaction.user.update({
          where: { id: user.id },
          data: { lockedUntil },
        });
      }
      await writeAuditLog(transaction, {
        actorId: user.id,
        action: "AUTH_LOGIN",
        targetType: "USER",
        targetId: user.id,
        result: "FAILURE",
        metadata: {
          reason: "INVALID_CREDENTIALS",
          failureCount: updatedUser.failedLoginCount,
        },
      });
      return { code: "INVALID_CREDENTIALS" as const, status: 401 };
    });
    throw new AuthError(failure.code, failure.status);
  }

  await dependencies.afterPasswordVerified?.();

  const authenticated = await dependencies.db.$transaction(async (transaction) => {
    const claimed = await transaction.user.updateMany({
      where: {
        id: user.id,
        passwordHash: user.passwordHash,
        enabled: true,
        status: UserStatus.ACTIVE,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    if (claimed.count !== 1) {
      await writeAuditLog(transaction, {
        actorId: user.id,
        action: "AUTH_LOGIN",
        targetType: "USER",
        targetId: user.id,
        result: "DENIED",
        metadata: { reason: "STALE_CREDENTIALS" },
      });
      return null;
    }
    const updatedUser = await transaction.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const session = await createSession(transaction, user.id, {
      now,
      ttlHours: dependencies.sessionTtlHours,
      viewMode:
        updatedUser.role === Role.ADMIN || updatedUser.role === Role.SUPER_ADMIN
          ? SessionViewMode.ADMIN
          : SessionViewMode.EMPLOYEE,
    });
    await writeAuditLog(transaction, {
      actorId: user.id,
      action: "AUTH_LOGIN",
      targetType: "USER",
      targetId: user.id,
      result: "SUCCESS",
    });
    return { updatedUser, session };
  });
  if (!authenticated) throw new AuthError("INVALID_CREDENTIALS", 401);

  return {
    user: {
      id: authenticated.updatedUser.id,
      employeeNo: authenticated.updatedUser.employeeNo,
      name: authenticated.updatedUser.name,
      role: authenticated.updatedUser.role,
      mustChangePassword: authenticated.updatedUser.mustChangePassword,
    },
    sessionToken: authenticated.session.token,
    sessionExpiresAt: authenticated.session.expiresAt,
  };
}

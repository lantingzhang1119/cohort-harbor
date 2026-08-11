import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { requireSessionForPasswordChange } from "@/features/auth/guards";
import { assertSameOrigin } from "@/features/auth/origin";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import { newPasswordSchema } from "@/features/auth/password-policy";
import { authErrorResponse, readSessionToken } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
});

type Dependencies = { db: PrismaClient; now?: () => Date };

class PasswordReuseError extends Error {}
class ConcurrentPasswordChangeError extends Error {}

export function createChangePasswordRoute(dependencies: Dependencies) {
  return async function handleChangePassword(request: Request): Promise<NextResponse> {
    try {
      assertSameOrigin(request);
      const input = inputSchema.parse(await request.json());
      const now = dependencies.now?.() ?? new Date();
      const session = await requireSessionForPasswordChange(
        dependencies.db,
        readSessionToken(request),
        now,
      );
      if (!(await verifyPassword(input.currentPassword, session.user.passwordHash))) {
        throw new AuthError("INVALID_CREDENTIALS", 401);
      }
      if (await verifyPassword(input.newPassword, session.user.passwordHash)) {
        throw new PasswordReuseError();
      }
      const passwordHash = await hashPassword(input.newPassword);
      const role = await dependencies.db.$transaction(async (transaction) => {
        const transactionNow = dependencies.now?.() ?? new Date();
        const claimedSession = await transaction.session.updateMany({
          where: {
            id: session.id,
            tokenHash: session.tokenHash,
            userId: session.userId,
            viewMode: session.viewMode,
            revokedAt: null,
            expiresAt: { gt: transactionNow },
            user: {
              is: {
                id: session.user.id,
                enabled: true,
                status: UserStatus.ACTIVE,
                role: session.user.role,
              },
            },
          },
          data: { viewMode: session.viewMode },
        });
        if (claimedSession.count !== 1) {
          throw new AuthError("UNAUTHENTICATED", 401);
        }

        const changed = await transaction.user.updateMany({
          where: {
            id: session.user.id,
            passwordHash: session.user.passwordHash,
            enabled: true,
            status: UserStatus.ACTIVE,
            role: session.user.role,
          },
          data: { passwordHash, mustChangePassword: false },
        });
        if (changed.count !== 1) throw new ConcurrentPasswordChangeError();
        await transaction.session.updateMany({
          where: {
            userId: session.user.id,
            id: { not: session.id },
            revokedAt: null,
          },
          data: { revokedAt: transactionNow },
        });
        await transaction.passwordResetToken.updateMany({
          where: { userId: session.user.id, usedAt: null },
          data: { usedAt: transactionNow },
        });
        await writeAuditLog(transaction, {
          actorId: session.user.id,
          action: "AUTH_PASSWORD_CHANGE",
          targetType: "USER",
          targetId: session.user.id,
          result: "SUCCESS",
        });
        return session.user.role;
      });
      return NextResponse.json({
        ok: true,
        redirectTo:
          role === Role.ADMIN || role === Role.SUPER_ADMIN
            ? "/admin"
            : "/employee",
      });
    } catch (error) {
      if (error instanceof PasswordReuseError) {
        return NextResponse.json(
          { ok: false, message: "新密码不能与当前密码相同" },
          { status: 400 },
        );
      }
      if (error instanceof ConcurrentPasswordChangeError) {
        return NextResponse.json(
          { ok: false, message: "密码已被其他请求更新，请重新登录后再试" },
          { status: 409 },
        );
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { ok: false, message: error.issues[0]?.message ?? "密码格式无效" },
          { status: 400 },
        );
      }
      return authErrorResponse(error);
    }
  };
}

export async function POST(request: Request) {
  return createChangePasswordRoute({ db: prisma })(request);
}

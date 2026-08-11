import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import { UserStatus } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import { newPasswordSchema } from "@/features/auth/password-policy";
import type {
  DevelopmentPreview,
  PasswordResetSender,
} from "@/features/auth/password-reset-sender";

const TOKEN_TTL_MS = 30 * 60 * 1_000;
const THROTTLE_ERROR_MARKER = "PASSWORD_RESET_THROTTLED";
const THROTTLE_WINDOW_MS = 15 * 60 * 1_000;
const THROTTLE_LIMIT = 3;

export const PASSWORD_RESET_PUBLIC_MESSAGE =
  "如果该账号存在且配置了邮箱，密码重置邮件将很快送达";

export type PasswordResetErrorCode =
  | "INVALID"
  | "EXPIRED"
  | "USED"
  | "PASSWORD_REUSE";

const errorMessages: Record<PasswordResetErrorCode, string> = {
  INVALID: "密码重置链接无效",
  EXPIRED: "密码重置链接已过期",
  USED: "密码重置链接已使用",
  PASSWORD_REUSE: "新密码不能与当前密码相同",
};

export class PasswordResetError extends Error {
  constructor(public readonly code: PasswordResetErrorCode) {
    super(errorMessages[code]);
    this.name = "PasswordResetError";
  }
}

function passwordResetHmac(secret: string) {
  if (secret.length < 32) {
    throw new Error("Password reset token secret must contain at least 32 characters");
  }
  return createHmac("sha256", secret);
}

export function hashPasswordResetToken(token: string, secret: string) {
  return passwordResetHmac(secret)
    .update("cohort-harbor:password-reset-token:v1\0")
    .update(token, "utf8")
    .digest("hex");
}

function requestFingerprint(userId: string, source: string, secret: string) {
  return passwordResetHmac(secret)
    .update("cohort-harbor:password-reset-request:v1\0")
    .update(userId, "utf8")
    .update("\0")
    .update(source, "utf8")
    .digest("hex");
}

function baseResult(developmentPreview?: DevelopmentPreview) {
  return {
    ok: true as const,
    message: PASSWORD_RESET_PUBLIC_MESSAGE,
    ...(developmentPreview ? { developmentPreview } : {}),
  };
}

export function publicPasswordResetResult(developmentPreview?: DevelopmentPreview) {
  return baseResult(developmentPreview);
}

export async function requestPasswordReset(
  dependencies: {
    db: PrismaClient;
    sender: PasswordResetSender;
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
    markDelivered?: (recordId: string, deliveredAt: Date) => Promise<void>;
    tokenHashSecret: string;
  },
  input: { identifier: string; requestSource: string },
) {
  const now = dependencies.now?.() ?? new Date();
  const makeToken = () =>
    (dependencies.randomBytes ?? nodeRandomBytes)(32).toString("base64url");
  const fakePreview = () =>
    dependencies.sender.createUnusableDevelopmentPreview?.(makeToken());
  const identifier = input.identifier.trim();
  const user = identifier
    ? await dependencies.db.user.findFirst({
        where: {
          enabled: true,
          status: UserStatus.ACTIVE,
          OR: [
            { employeeNo: identifier },
            { email: identifier.toLowerCase() },
          ],
        },
        select: {
          id: true,
          employeeNo: true,
          name: true,
          email: true,
          role: true,
          passwordHash: true,
          updatedAt: true,
        },
      })
    : null;

  if (!user || !user.email) {
    return baseResult(fakePreview());
  }
  if (dependencies.sender.mode === "UNAVAILABLE") {
    await writeAuditLog(dependencies.db, {
      action: "AUTH_PASSWORD_RESET_REQUEST",
      targetType: "USER",
      targetId: user.id,
      result: "FAILURE",
      metadata: { reason: "SMTP_NOT_CONFIGURED" },
    });
    return baseResult();
  }

  const fingerprint = requestFingerprint(user.id, input.requestSource, dependencies.tokenHashSecret);
  const token = makeToken();
  const tokenHash = hashPasswordResetToken(token, dependencies.tokenHashSecret);
  let record: { id: string } | null;
  try {
    record = await dependencies.db.$transaction(async (transaction) => {
      const claimed = await transaction.user.updateMany({
        where: {
          id: user.id,
          employeeNo: user.employeeNo,
          email: user.email,
          role: user.role,
          passwordHash: user.passwordHash,
          enabled: true,
          status: UserStatus.ACTIVE,
          updatedAt: user.updatedAt,
        },
        data: { updatedAt: user.updatedAt },
      });
      if (claimed.count !== 1) return null;
      return transaction.passwordResetToken.create({
        data: {
          tokenHash,
          userId: user.id,
          expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
          requestFingerprint: fingerprint,
          createdAt: now,
        },
        select: { id: true },
      });
    });
  } catch (error) {
    const matchingReservations = await dependencies.db.passwordResetToken.count({
      where: {
        requestFingerprint: fingerprint,
        createdAt: {
          gte: new Date(now.getTime() - THROTTLE_WINDOW_MS),
          lte: now,
        },
      },
    });
    if (
      String(error).includes(THROTTLE_ERROR_MARKER) ||
      matchingReservations >= THROTTLE_LIMIT
    ) {
      return baseResult(fakePreview());
    }
    throw error;
  }
  if (!record) return baseResult(fakePreview());

  const markDeliveryFailed = async () => {
    await dependencies.db.passwordResetToken.updateMany({
      where: { id: record.id },
      data: { deliveredAt: null, deliveryFailedAt: now },
    }).catch(() => undefined);
  };

  try {
    const delivery = await dependencies.sender.send({
      recipient: {
        id: user.id,
        employeeNo: user.employeeNo,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      token,
    });
    if (dependencies.markDelivered) {
      await dependencies.markDelivered(record.id, now);
      const activated = await dependencies.db.passwordResetToken.findUnique({
        where: { id: record.id },
        select: { deliveredAt: true, deliveryFailedAt: true, usedAt: true },
      });
      if (!activated?.deliveredAt || activated.deliveryFailedAt || activated.usedAt) {
        throw new Error("Password reset activation was not persisted");
      }
    } else {
      const activated = await dependencies.db.passwordResetToken.updateMany({
        where: {
          id: record.id,
          usedAt: null,
          deliveredAt: null,
          deliveryFailedAt: null,
        },
        data: { deliveredAt: now },
      });
      if (activated.count !== 1) throw new Error("Password reset activation failed");
    }
    return baseResult(delivery.developmentPreview);
  } catch {
    await markDeliveryFailed();
    return baseResult(fakePreview());
  }
}

export async function consumePasswordReset(
  dependencies: { db: PrismaClient; tokenHashSecret: string; now?: () => Date },
  input: { token: string; newPassword: string },
) {
  const parsedPassword = newPasswordSchema.parse(input.newPassword);
  const now = dependencies.now?.() ?? new Date();
  const tokenHash = hashPasswordResetToken(input.token, dependencies.tokenHashSecret);

  return dependencies.db.$transaction(async (transaction) => {
    const resetToken = await transaction.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!resetToken) throw new PasswordResetError("INVALID");
    if (!resetToken.user.enabled || resetToken.user.status !== UserStatus.ACTIVE) {
      throw new PasswordResetError("INVALID");
    }
    if (!resetToken.deliveredAt || resetToken.deliveryFailedAt) {
      throw new PasswordResetError("INVALID");
    }
    if (resetToken.usedAt) throw new PasswordResetError("USED");
    if (now >= resetToken.expiresAt) throw new PasswordResetError("EXPIRED");
    if (await verifyPassword(parsedPassword, resetToken.user.passwordHash)) {
      throw new PasswordResetError("PASSWORD_REUSE");
    }

    const claimed = await transaction.passwordResetToken.updateMany({
      where: {
        id: resetToken.id,
        usedAt: null,
        expiresAt: { gt: now },
        deliveredAt: { not: null },
        deliveryFailedAt: null,
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new PasswordResetError("USED");

    const passwordHash = await hashPassword(parsedPassword);
    const passwordUpdated = await transaction.user.updateMany({
      where: {
        id: resetToken.userId,
        enabled: true,
        status: UserStatus.ACTIVE,
      },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    if (passwordUpdated.count !== 1) throw new PasswordResetError("INVALID");
    await transaction.session.updateMany({
      where: { userId: resetToken.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, usedAt: null },
      data: { usedAt: now },
    });
    await writeAuditLog(transaction, {
      action: "AUTH_PASSWORD_RESET",
      targetType: "USER",
      targetId: resetToken.userId,
      result: "SUCCESS",
    });
    return { userId: resetToken.userId };
  });
}

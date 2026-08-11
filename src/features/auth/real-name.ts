import type { PrismaClient } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { prisma } from "@/lib/db/client";

const RESERVED_DISPLAY_NAMES = new Set([
  "admin",
  "administrator",
  "root",
  "super admin",
  "super administrator",
  "system admin",
  "system administrator",
  "管理员",
  "系统管理员",
  "超级管理员",
]);

export class InvalidDisplayNameError extends Error {
  readonly code = "INVALID_DISPLAY_NAME";

  constructor(message = "请输入 2–80 个字符的真实姓名") {
    super(message);
    this.name = "InvalidDisplayNameError";
  }
}

export function normalizeDisplayName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function isReservedDisplayName(name: string): boolean {
  return RESERVED_DISPLAY_NAMES.has(normalizeDisplayName(name).toLocaleLowerCase("en-US"));
}

export function requiresRealNameBeforeEmployeeView(user: {
  role: Role;
  name: string;
}): boolean {
  return (
    (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) &&
    isReservedDisplayName(user.name)
  );
}

function validateDisplayName(value: string): string {
  const name = normalizeDisplayName(value);
  if (name.length < 2 || name.length > 80 || isReservedDisplayName(name)) {
    throw new InvalidDisplayNameError();
  }
  if (/\p{C}/u.test(name)) {
    throw new InvalidDisplayNameError();
  }
  return name;
}

export async function updateOwnDisplayName(
  input: { actorId: string; name: string },
  db: PrismaClient = prisma,
): Promise<{ name: string }> {
  const name = validateDisplayName(input.name);
  await db.$transaction(async (transaction) => {
    const actor = await transaction.user.findUnique({
      where: { id: input.actorId },
      select: { id: true, name: true, role: true },
    });
    if (!actor || (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN)) {
      throw new AuthError("FORBIDDEN", 403);
    }

    await transaction.user.update({
      where: { id: actor.id },
      data: { name },
    });
    await writeAuditLog(transaction, {
      actorId: actor.id,
      action: "ADMIN_PROFILE_UPDATED",
      targetType: "USER",
      targetId: actor.id,
      result: "SUCCESS",
      metadata: { beforeName: actor.name, afterName: name },
    });
  });
  return { name };
}

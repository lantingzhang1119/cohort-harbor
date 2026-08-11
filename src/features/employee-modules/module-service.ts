import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import {
  EMPLOYEE_MODULE_KEYS,
  isEmployeeModuleKey,
} from "@/features/employee-modules/module-definitions";
import { prisma } from "@/lib/db/client";

function normalizedEnabledKeys(keys: readonly EmployeeModuleKey[]) {
  if (
    keys.some((key) => !isEmployeeModuleKey(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw new TypeError("员工端板块设置格式无效");
  }
  const selected = new Set(keys);
  return EMPLOYEE_MODULE_KEYS.filter((key) => selected.has(key));
}

export async function getEnabledEmployeeModules(
  db: PrismaClient = prisma,
): Promise<ReadonlySet<EmployeeModuleKey>> {
  try {
    const rows = await db.employeeModuleSetting.findMany({
      select: { key: true, enabled: true },
    });
    if (
      rows.length !== EMPLOYEE_MODULE_KEYS.length ||
      rows.some(({ key }) => !isEmployeeModuleKey(key)) ||
      new Set(rows.map(({ key }) => key)).size !== EMPLOYEE_MODULE_KEYS.length
    ) {
      return new Set<EmployeeModuleKey>();
    }
    return new Set(rows.filter(({ enabled }) => enabled).map(({ key }) => key));
  } catch {
    return new Set<EmployeeModuleKey>();
  }
}

export async function updateEmployeeModules(
  actorId: string,
  enabledKeys: readonly EmployeeModuleKey[],
  db: PrismaClient = prisma,
): Promise<void> {
  const after = normalizedEnabledKeys(enabledKeys);
  await db.$transaction(async (transaction) => {
    const actor = await transaction.user.findUnique({ where: { id: actorId } });
    if (!actor || (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN)) {
      throw new AuthError("FORBIDDEN", 403);
    }
    const current = await transaction.employeeModuleSetting.findMany({
      where: { enabled: true },
      select: { key: true },
    });
    const currentSet = new Set(current.map(({ key }) => key));
    const before = EMPLOYEE_MODULE_KEYS.filter((key) => currentSet.has(key));
    const afterSet = new Set(after);
    const actorSnapshot = snapshotUserIdentity(actor);
    for (const key of EMPLOYEE_MODULE_KEYS) {
      await transaction.employeeModuleSetting.upsert({
        where: { key },
        create: {
          key,
          enabled: afterSet.has(key),
          updatedById: actorId,
          updatedBySnapshot: actorSnapshot,
        },
        update: {
          enabled: afterSet.has(key),
          updatedById: actorId,
          updatedBySnapshot: actorSnapshot,
        },
      });
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "EMPLOYEE_MODULE_SETTINGS_UPDATE",
      targetType: "EMPLOYEE_MODULE_SETTINGS",
      targetId: "global",
      result: "SUCCESS",
      metadata: { before, after },
    });
  });
}

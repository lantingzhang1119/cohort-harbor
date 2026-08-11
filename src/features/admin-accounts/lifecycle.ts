import type { Role, UserStatus } from "@/generated/prisma/enums";

export type AdminOperationalState = {
  role: Role;
  status: UserStatus;
  enabled: boolean;
  adminArchivedAt: Date | string | null;
};

export function isOperationallyActiveAdmin(
  account: AdminOperationalState,
): boolean {
  return (
    account.role === "ADMIN" &&
    account.enabled &&
    account.status === "ACTIVE" &&
    account.adminArchivedAt === null
  );
}

export function partitionOrdinaryAdminAccounts<T extends AdminOperationalState>(
  accounts: readonly T[],
): { active: T[]; disabled: T[] } {
  const ordinary = accounts.filter((account) => account.role === "ADMIN");
  return {
    active: ordinary.filter(isOperationallyActiveAdmin),
    disabled: ordinary.filter((account) => !isOperationallyActiveAdmin(account)),
  };
}

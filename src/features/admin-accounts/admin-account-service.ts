import { Prisma, type PrismaClient, type User } from "@/generated/prisma/client";
import {
  AdminIdentityEvent,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { isOperationallyActiveAdmin } from "@/features/admin-accounts/lifecycle";
import {
  adminIdentityInputSchema,
  createAdminInputSchema,
  destructiveConfirmationSchema,
  type AdminIdentityInput,
  type CreateAdminInput,
  type DestructiveConfirmationInput,
} from "@/features/admin-accounts/schemas";
import { writeAuditLog } from "@/features/audit/audit-service";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import { generateTemporaryPassword } from "@/features/auth/temporary-password";

const adminAccountSelect = {
  id: true,
  employeeNo: true,
  name: true,
  email: true,
  role: true,
  status: true,
  enabled: true,
  mustChangePassword: true,
  adminArchivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Transaction = Prisma.TransactionClient;

export type AdminAccountServiceErrorCode =
  | "VALIDATION_ERROR"
  | "SUPER_ADMIN_REQUIRED"
  | "SUPER_ADMIN_INVARIANT"
  | "SUPER_ADMIN_IMMUTABLE"
  | "ADMIN_NOT_FOUND"
  | "DUPLICATE_EMPLOYEE_NO"
  | "DUPLICATE_EMAIL"
  | "INVALID_CURRENT_PASSWORD"
  | "NEW_PASSWORD_REUSED"
  | "SELF_DELETE_FORBIDDEN"
  | "ADMIN_ALREADY_ARCHIVED"
  | "ADMIN_NOT_ARCHIVED";

const errorMessages: Record<AdminAccountServiceErrorCode, string> = {
  VALIDATION_ERROR: "管理员信息格式不正确",
  SUPER_ADMIN_REQUIRED: "仅超级管理员可执行此操作",
  SUPER_ADMIN_INVARIANT: "超级管理员账号状态异常，操作已取消",
  SUPER_ADMIN_IMMUTABLE: "超级管理员不能被归档或停用",
  ADMIN_NOT_FOUND: "管理员账号不存在",
  DUPLICATE_EMPLOYEE_NO: "该工号已存在",
  DUPLICATE_EMAIL: "该邮箱已被使用",
  INVALID_CURRENT_PASSWORD: "当前超级管理员密码不正确",
  NEW_PASSWORD_REUSED: "新临时密码不能与账号当前密码相同",
  SELF_DELETE_FORBIDDEN: "不能永久删除当前登录账号",
  ADMIN_ALREADY_ARCHIVED: "管理员账号已归档",
  ADMIN_NOT_ARCHIVED: "管理员账号尚未归档",
};

export class AdminAccountServiceError extends Error {
  constructor(
    public readonly code: AdminAccountServiceErrorCode,
    message = errorMessages[code],
    public readonly existingUserId?: string,
  ) {
    super(message);
    this.name = "AdminAccountServiceError";
  }
}

function parseInput<T>(schema: { parse(value: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    const message =
      typeof error === "object" && error && "issues" in error
        ? String((error as { issues?: Array<{ message?: string }> }).issues?.[0]?.message)
        : errorMessages.VALIDATION_ERROR;
    throw new AdminAccountServiceError("VALIDATION_ERROR", message);
  }
}

async function requireSoleSuperAdministrator(
  transaction: Transaction,
  actorId: string,
): Promise<User> {
  const actor = await transaction.user.findUnique({ where: { id: actorId } });
  if (!actor || actor.role !== Role.SUPER_ADMIN) {
    throw new AdminAccountServiceError("SUPER_ADMIN_REQUIRED");
  }
  const activeSuperAdministrators = await transaction.user.findMany({
    where: {
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      enabled: true,
      adminArchivedAt: null,
    },
    select: { id: true },
  });
  if (
    activeSuperAdministrators.length !== 1 ||
    activeSuperAdministrators[0]?.id !== actor.id
  ) {
    throw new AdminAccountServiceError("SUPER_ADMIN_INVARIANT");
  }
  return actor;
}

async function findAdministrator(transaction: Transaction, accountId: string) {
  const administrator = await transaction.user.findFirst({
    where: { id: accountId, role: { in: [Role.SUPER_ADMIN, Role.ADMIN] } },
  });
  if (!administrator) throw new AdminAccountServiceError("ADMIN_NOT_FOUND");
  return administrator;
}

async function assertUniqueIdentity(
  transaction: Transaction,
  identity: { employeeNo: string; email: string },
  excludedAccountId?: string,
) {
  const duplicateEmployeeNo = await transaction.user.findFirst({
    where: {
      employeeNo: identity.employeeNo,
      ...(excludedAccountId ? { id: { not: excludedAccountId } } : {}),
    },
    select: { id: true },
  });
  if (duplicateEmployeeNo) {
    throw new AdminAccountServiceError(
      "DUPLICATE_EMPLOYEE_NO",
      undefined,
      duplicateEmployeeNo.id,
    );
  }
  const duplicateEmail = await transaction.user.findFirst({
    where: {
      email: identity.email,
      ...(excludedAccountId ? { id: { not: excludedAccountId } } : {}),
    },
    select: { id: true },
  });
  if (duplicateEmail) {
    throw new AdminAccountServiceError(
      "DUPLICATE_EMAIL",
      undefined,
      duplicateEmail.id,
    );
  }
}

function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

export async function listAdminAccounts(db: PrismaClient, actorId: string) {
  return db.$transaction(async (transaction) => {
    await requireSoleSuperAdministrator(transaction, actorId);
    const items = await transaction.user.findMany({
      where: { role: { in: [Role.SUPER_ADMIN, Role.ADMIN] } },
      orderBy: [
        { role: "desc" },
        { adminArchivedAt: "asc" },
        { employeeNo: "asc" },
      ],
      select: adminAccountSelect,
    });
    return { items };
  });
}

export async function getAdminAccount(
  db: PrismaClient,
  accountId: string,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    await requireSoleSuperAdministrator(transaction, actorId);
    await findAdministrator(transaction, accountId);
    return transaction.user.findUniqueOrThrow({
      where: { id: accountId },
      select: adminAccountSelect,
    });
  });
}

export async function createAdminAccount(
  db: PrismaClient,
  input: CreateAdminInput,
  actorId: string,
) {
  const parsed = parseInput(createAdminInputSchema, input);
  const email = normalizeEmail(parsed.email);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const admin = await db.$transaction(async (transaction) => {
    await requireSoleSuperAdministrator(transaction, actorId);
    await assertUniqueIdentity(transaction, { employeeNo: parsed.employeeNo, email });
    const created = await transaction.user.create({
      data: {
        employeeNo: parsed.employeeNo,
        name: parsed.name,
        email,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        enabled: true,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: true,
      },
    });
    const snapshot = snapshotUserIdentity(created);
    await transaction.adminIdentityHistory.create({
      data: {
        subjectAccountId: created.id,
        subjectId: created.id,
        actorId,
        event: AdminIdentityEvent.CREATED,
        afterSnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "ADMIN_ACCOUNT_CREATE",
      targetType: "USER",
      targetId: created.id,
      result: "SUCCESS",
      metadata: { role: Role.ADMIN },
    });
    return transaction.user.findUniqueOrThrow({
      where: { id: created.id },
      select: adminAccountSelect,
    });
  });

  return { admin, temporaryPassword };
}

export async function transferAdminAccount(
  db: PrismaClient,
  accountId: string,
  input: AdminIdentityInput,
  actorId: string,
) {
  const parsed = parseInput(adminIdentityInputSchema, input);
  const email = normalizeEmail(parsed.email);
  const passwordHash = await hashPassword(parsed.temporaryPassword);

  return db.$transaction(async (transaction) => {
    const actor = await requireSoleSuperAdministrator(transaction, actorId);
    const subject = await findAdministrator(transaction, accountId);
    if (subject.role === Role.SUPER_ADMIN && subject.id !== actor.id) {
      throw new AdminAccountServiceError("SUPER_ADMIN_IMMUTABLE");
    }
    if (!(await verifyPassword(parsed.currentPassword, actor.passwordHash))) {
      throw new AdminAccountServiceError("INVALID_CURRENT_PASSWORD");
    }
    if (await verifyPassword(parsed.temporaryPassword, subject.passwordHash)) {
      throw new AdminAccountServiceError("NEW_PASSWORD_REUSED");
    }
    await assertUniqueIdentity(
      transaction,
      { employeeNo: parsed.employeeNo, email },
      subject.id,
    );
    const beforeSnapshot = snapshotUserIdentity(subject);
    const updated = await transaction.user.update({
      where: { id: subject.id },
      data: {
        employeeNo: parsed.employeeNo,
        name: parsed.name,
        email,
        passwordHash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    const afterSnapshot = snapshotUserIdentity(updated);
    await transaction.session.updateMany({
      where: { userId: subject.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await transaction.passwordResetToken.deleteMany({
      where: { userId: subject.id, usedAt: null },
    });
    await transaction.adminIdentityHistory.create({
      data: {
        subjectAccountId: subject.id,
        subjectId: subject.id,
        actorId: actor.id,
        event: AdminIdentityEvent.TRANSFERRED,
        beforeSnapshot,
        afterSnapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId: actor.id,
      action: "ADMIN_ACCOUNT_TRANSFER",
      targetType: "USER",
      targetId: subject.id,
      result: "SUCCESS",
      metadata: { role: subject.role },
    });
    return transaction.user.findUniqueOrThrow({
      where: { id: subject.id },
      select: adminAccountSelect,
    });
  });
}

export async function archiveAdminAccount(
  db: PrismaClient,
  accountId: string,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    const actor = await requireSoleSuperAdministrator(transaction, actorId);
    const subject = await findAdministrator(transaction, accountId);
    if (subject.role === Role.SUPER_ADMIN) {
      throw new AdminAccountServiceError("SUPER_ADMIN_IMMUTABLE");
    }
    if (!isOperationallyActiveAdmin(subject)) {
      throw new AdminAccountServiceError("ADMIN_ALREADY_ARCHIVED");
    }
    const archivedAt = new Date();
    const updated = await transaction.user.update({
      where: { id: subject.id },
      data: {
        enabled: false,
        status: UserStatus.DISABLED,
        adminArchivedAt: archivedAt,
      },
    });
    await transaction.session.updateMany({
      where: { userId: subject.id, revokedAt: null },
      data: { revokedAt: archivedAt },
    });
    await transaction.passwordResetToken.updateMany({
      where: { userId: subject.id, usedAt: null },
      data: { usedAt: archivedAt },
    });
    await transaction.adminIdentityHistory.create({
      data: {
        subjectAccountId: subject.id,
        subjectId: subject.id,
        actorId: actor.id,
        event: AdminIdentityEvent.ARCHIVED,
        beforeSnapshot: snapshotUserIdentity(subject),
        afterSnapshot: snapshotUserIdentity(updated),
      },
    });
    await writeAuditLog(transaction, {
      actorId: actor.id,
      action: "ADMIN_ACCOUNT_ARCHIVE",
      targetType: "USER",
      targetId: subject.id,
      result: "SUCCESS",
    });
    return transaction.user.findUniqueOrThrow({
      where: { id: subject.id },
      select: adminAccountSelect,
    });
  });
}

export async function restoreAdminAccount(
  db: PrismaClient,
  accountId: string,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    const actor = await requireSoleSuperAdministrator(transaction, actorId);
    const subject = await findAdministrator(transaction, accountId);
    if (subject.role === Role.SUPER_ADMIN) {
      throw new AdminAccountServiceError("SUPER_ADMIN_IMMUTABLE");
    }
    if (isOperationallyActiveAdmin(subject)) {
      throw new AdminAccountServiceError("ADMIN_NOT_ARCHIVED");
    }
    const restoredAt = new Date();
    await transaction.session.updateMany({
      where: { userId: subject.id, revokedAt: null },
      data: { revokedAt: restoredAt },
    });
    await transaction.passwordResetToken.updateMany({
      where: { userId: subject.id, usedAt: null },
      data: { usedAt: restoredAt },
    });
    const updated = await transaction.user.update({
      where: { id: subject.id },
      data: {
        enabled: true,
        status: UserStatus.ACTIVE,
        adminArchivedAt: null,
      },
    });
    await transaction.adminIdentityHistory.create({
      data: {
        subjectAccountId: subject.id,
        subjectId: subject.id,
        actorId: actor.id,
        event: AdminIdentityEvent.RESTORED,
        beforeSnapshot: snapshotUserIdentity(subject),
        afterSnapshot: snapshotUserIdentity(updated),
      },
    });
    await writeAuditLog(transaction, {
      actorId: actor.id,
      action: "ADMIN_ACCOUNT_RESTORE",
      targetType: "USER",
      targetId: subject.id,
      result: "SUCCESS",
    });
    return transaction.user.findUniqueOrThrow({
      where: { id: subject.id },
      select: adminAccountSelect,
    });
  });
}

async function detachHistoricalActorRelations(
  transaction: Transaction,
  subject: User,
) {
  const snapshot = snapshotUserIdentity(subject);
  await transaction.auditLog.updateMany({
    where: { actorId: subject.id, actorSnapshot: { equals: Prisma.DbNull } },
    data: { actorSnapshot: snapshot },
  });
  await transaction.retakeApplication.updateMany({
    where: { reviewerId: subject.id, reviewerSnapshot: { equals: Prisma.DbNull } },
    data: { reviewerSnapshot: snapshot },
  });
  await transaction.simulatedEmailLog.updateMany({
    where: { actorId: subject.id, actorSnapshot: { equals: Prisma.DbNull } },
    data: { actorSnapshot: snapshot },
  });

  await transaction.auditLog.updateMany({ where: { actorId: subject.id }, data: { actorId: null } });
  await transaction.rosterImportBatch.updateMany({ where: { actorId: subject.id }, data: { actorId: null } });
  await transaction.guideRevision.updateMany({ where: { actorId: subject.id }, data: { actorId: null } });
  await transaction.fileAsset.updateMany({ where: { uploadedById: subject.id }, data: { uploadedById: null } });
  await transaction.retakeApplication.updateMany({ where: { reviewerId: subject.id }, data: { reviewerId: null } });
  await transaction.simulatedEmailLog.updateMany({ where: { actorId: subject.id }, data: { actorId: null } });
  await transaction.adminIdentityHistory.updateMany({ where: { actorId: subject.id }, data: { actorId: null } });
  await transaction.adminIdentityHistory.updateMany({ where: { subjectId: subject.id }, data: { subjectId: null } });
  await transaction.guidePortalDraft.updateMany({ where: { updatedById: subject.id }, data: { updatedById: null } });
  await transaction.guidePortalPublication.updateMany({ where: { publishedById: subject.id }, data: { publishedById: null } });
}

export async function permanentlyDeleteAdminAccount(
  db: PrismaClient,
  accountId: string,
  input: DestructiveConfirmationInput,
  actorId: string,
) {
  const parsed = parseInput(destructiveConfirmationSchema, input);
  return db.$transaction(async (transaction) => {
    const actor = await requireSoleSuperAdministrator(transaction, actorId);
    const subject = await findAdministrator(transaction, accountId);
    if (subject.id === actor.id) {
      throw new AdminAccountServiceError("SELF_DELETE_FORBIDDEN");
    }
    if (subject.role === Role.SUPER_ADMIN) {
      throw new AdminAccountServiceError("SUPER_ADMIN_IMMUTABLE");
    }
    if (!(await verifyPassword(parsed.currentPassword, actor.passwordHash))) {
      throw new AdminAccountServiceError("INVALID_CURRENT_PASSWORD");
    }

    const beforeSnapshot = snapshotUserIdentity(subject);
    await detachHistoricalActorRelations(transaction, subject);
    await transaction.session.updateMany({
      where: { userId: subject.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await transaction.passwordResetToken.deleteMany({ where: { userId: subject.id } });
    await transaction.adminIdentityHistory.create({
      data: {
        subjectAccountId: subject.id,
        subjectId: subject.id,
        actorId: actor.id,
        event: AdminIdentityEvent.PERMANENTLY_DELETED,
        beforeSnapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId: actor.id,
      action: "ADMIN_ACCOUNT_PERMANENT_DELETE",
      targetType: "USER",
      targetId: subject.id,
      result: "SUCCESS",
      metadata: { subjectSnapshot: beforeSnapshot },
    });
    await transaction.user.delete({ where: { id: subject.id } });
    return { id: subject.id };
  });
}

import type { PrismaClient } from "@/generated/prisma/client";
import { Role, UserSource, UserStatus, WorkLocation } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { hashPassword } from "@/features/auth/password";
import { generateTemporaryPassword } from "@/features/auth/temporary-password";
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type UpdateEmployeeInput,
} from "@/features/employees/schemas";
import { rescheduleAutomaticWelcomeMailForUsers } from "@/features/onboarding-mail/scheduler";

export const EMPLOYEE_INITIAL_PASSWORD = "DemoEmployeePass2026";

const employeeAdminSelect = {
  id: true,
  employeeNo: true,
  name: true,
  email: true,
  role: true,
  status: true,
  enabled: true,
  workLocation: true,
  firstDepartment: true,
  secondDepartment: true,
  position: true,
  hiredAt: true,
  leftAt: true,
  sourceType: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type EmployeeServiceErrorCode =
  | "VALIDATION_ERROR"
  | "DUPLICATE_EMPLOYEE_NO"
  | "DUPLICATE_EMAIL"
  | "EMPLOYEE_NOT_FOUND"
  | "FORBIDDEN";

export class EmployeeServiceError extends Error {
  constructor(
    public readonly code: EmployeeServiceErrorCode,
    message: string,
    public readonly existingUserId?: string,
  ) {
    super(message);
    this.name = "EmployeeServiceError";
  }
}

function validationError(error: unknown): never {
  const message =
    typeof error === "object" && error && "issues" in error
      ? String((error as { issues?: Array<{ message?: string }> }).issues?.[0]?.message)
      : "员工信息格式不正确";
  throw new EmployeeServiceError("VALIDATION_ERROR", message);
}

export async function createEmployee(
  db: PrismaClient,
  input: CreateEmployeeInput,
  actorId: string,
) {
  let parsed;
  try {
    parsed = createEmployeeSchema.parse(input);
  } catch (error) {
    validationError(error);
  }

  const duplicateNumber = await db.user.findUnique({
    where: { employeeNo: parsed.employeeNo },
    select: { id: true },
  });
  if (duplicateNumber) {
    throw new EmployeeServiceError(
      "DUPLICATE_EMPLOYEE_NO",
      "该工号已存在",
      duplicateNumber.id,
    );
  }
  const email = parsed.email.toLowerCase();
  const duplicateEmail = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (duplicateEmail) {
    throw new EmployeeServiceError("DUPLICATE_EMAIL", "该邮箱已被使用", duplicateEmail.id);
  }

  const passwordHash = await hashPassword(EMPLOYEE_INITIAL_PASSWORD);
  return db.$transaction(async (transaction) => {
    const employee = await transaction.user.create({
      data: {
        employeeNo: parsed.employeeNo,
        name: parsed.name,
        email,
        firstDepartment: parsed.firstDepartment,
        secondDepartment: parsed.secondDepartment,
        position: parsed.position,
        workLocation: parsed.workLocation,
        hiredAt: parsed.hiredAt,
        leftAt: parsed.leftAt,
        passwordHash,
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        mustChangePassword: true,
      },
      select: employeeAdminSelect,
    });
    const exam = await transaction.exam.findFirst({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, dueDaysAfterHire: true },
    });
    if (exam) {
      await transaction.examAssignment.create({
        data: {
          userId: employee.id,
          examId: exam.id,
          dueAt: new Date(employee.hiredAt!.getTime() + exam.dueDaysAfterHire * 86_400_000),
        },
      });
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "EMPLOYEE_CREATE",
      targetType: "USER",
      targetId: employee.id,
      result: "SUCCESS",
      metadata: { source: "MANUAL" },
    });
    return employee;
  });
}

export async function updateEmployee(
  db: PrismaClient,
  employeeId: string,
  input: UpdateEmployeeInput,
  actorId: string,
) {
  let parsed;
  try {
    parsed = updateEmployeeSchema.parse(input);
  } catch (error) {
    validationError(error);
  }
  if (parsed.email) {
    parsed.email = parsed.email.toLowerCase();
    const duplicate = await db.user.findFirst({
      where: { email: parsed.email, id: { not: employeeId } },
      select: { id: true },
    });
    if (duplicate) {
      throw new EmployeeServiceError("DUPLICATE_EMAIL", "该邮箱已被使用", duplicate.id);
    }
  }
  const employee = await db.$transaction(async (transaction) => {
    const current = await transaction.user.findFirst({
      where: { id: employeeId, role: Role.EMPLOYEE },
      select: { id: true, email: true },
    });
    if (!current) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", "员工不存在");
    const statusBecameInactive = Boolean(
      parsed.status && parsed.status !== UserStatus.ACTIVE,
    );
    const emailChanged = parsed.email !== undefined && parsed.email !== current.email;
    const employee = await transaction.user.update({
      where: { id: employeeId },
      data: parsed,
      select: employeeAdminSelect,
    });
    const credentialInvalidatedAt = new Date();
    if (statusBecameInactive) {
      await transaction.session.updateMany({
        where: { userId: employeeId, revokedAt: null },
        data: { revokedAt: credentialInvalidatedAt },
      });
    }
    if (statusBecameInactive || emailChanged) {
      await transaction.passwordResetToken.updateMany({
        where: { userId: employeeId, usedAt: null },
        data: { usedAt: credentialInvalidatedAt },
      });
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "EMPLOYEE_UPDATE",
      targetType: "USER",
      targetId: employeeId,
      result: "SUCCESS",
      metadata: { fields: Object.keys(parsed).sort() },
    });
    return employee;
  });
  await rescheduleAutomaticWelcomeMailForUsers(db, [employeeId]);
  return employee;
}

export async function bulkSetLocation(
  db: PrismaClient,
  employeeIds: string[],
  location: WorkLocation,
  actorId: string,
): Promise<number> {
  if (!Object.values(WorkLocation).includes(location)) {
    throw new EmployeeServiceError("VALIDATION_ERROR", "工作地点无效");
  }
  return db.$transaction(async (transaction) => {
    const result = await transaction.user.updateMany({
      where: { id: { in: [...new Set(employeeIds)] }, role: Role.EMPLOYEE },
      data: { workLocation: location },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "EMPLOYEE_BULK_LOCATION",
      targetType: "USER",
      result: "SUCCESS",
      metadata: { count: result.count, location },
    });
    return result.count;
  });
}

export async function setEmployeesEnabled(
  db: PrismaClient,
  employeeIds: string[],
  enabled: boolean,
  actorId: string,
): Promise<number> {
  const { count, affectedIds } = await db.$transaction(async (transaction) => {
    const ids = [...new Set(employeeIds)];
    const affectedIds = (
      await transaction.user.findMany({
        where: { id: { in: ids }, role: Role.EMPLOYEE },
        select: { id: true },
      })
    ).map((employee) => employee.id);
    const result = await transaction.user.updateMany({
      where: { id: { in: affectedIds }, role: Role.EMPLOYEE },
      data: { enabled },
    });
    if (!enabled) {
      const disabledAt = new Date();
      await transaction.session.updateMany({
        where: { userId: { in: affectedIds }, revokedAt: null },
        data: { revokedAt: disabledAt },
      });
      await transaction.passwordResetToken.updateMany({
        where: { userId: { in: affectedIds }, usedAt: null },
        data: { usedAt: disabledAt },
      });
    }
    await writeAuditLog(transaction, {
      actorId,
      action: enabled ? "EMPLOYEE_ENABLE" : "EMPLOYEE_DISABLE",
      targetType: "USER",
      result: "SUCCESS",
      metadata: { count: result.count },
    });
    return { count: result.count, affectedIds };
  });
  await rescheduleAutomaticWelcomeMailForUsers(db, affectedIds);
  return count;
}

export async function resetEmployeePassword(
  db: PrismaClient,
  employeeId: string,
  actorId: string,
) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();
  await db.$transaction(async (transaction) => {
    const actor = await transaction.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true, status: true, enabled: true, adminArchivedAt: true },
    });
    if (
      !actor ||
      !actor.enabled ||
      actor.status !== UserStatus.ACTIVE ||
      actor.adminArchivedAt ||
      (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN)
    ) {
      throw new EmployeeServiceError("FORBIDDEN", "无权重置员工密码");
    }
    const employee = await transaction.user.findFirst({
      where: { id: employeeId, role: Role.EMPLOYEE },
      select: { id: true },
    });
    if (!employee) {
      throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", "员工不存在");
    }
    await transaction.user.update({
      where: { id: employeeId },
      data: {
        passwordHash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await transaction.session.updateMany({
      where: { userId: employeeId, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.passwordResetToken.updateMany({
      where: { userId: employeeId, usedAt: null },
      data: { usedAt: now },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "EMPLOYEE_PASSWORD_RESET",
      targetType: "USER",
      targetId: employeeId,
      result: "SUCCESS",
    });
  });
  return temporaryPassword;
}

export const EMPLOYEE_PAGE_SIZES = [10, 20, 50, 100] as const;
export type EmployeePageSize = (typeof EMPLOYEE_PAGE_SIZES)[number];
export const DEFAULT_EMPLOYEE_PAGE_SIZE: EmployeePageSize = 20;

function resolveEmployeePage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function resolveEmployeePageSize(value: number | undefined): EmployeePageSize {
  if (typeof value === "number" && (EMPLOYEE_PAGE_SIZES as readonly number[]).includes(value)) {
    return value as EmployeePageSize;
  }
  return DEFAULT_EMPLOYEE_PAGE_SIZE;
}

export async function listEmployees(
  db: PrismaClient,
  filters: {
    query?: string;
    department?: string;
    location?: WorkLocation;
    enabled?: boolean;
    sourceType?: UserSource;
    page?: number;
    pageSize?: number;
  } = {},
) {
  const page = resolveEmployeePage(filters.page);
  const pageSize = resolveEmployeePageSize(filters.pageSize);
  const where = {
    role: Role.EMPLOYEE,
    ...(filters.query
      ? {
          OR: [
            { employeeNo: { contains: filters.query } },
            { name: { contains: filters.query } },
          ],
        }
      : {}),
    ...(filters.department ? { firstDepartment: filters.department } : {}),
    ...(filters.location ? { workLocation: filters.location } : {}),
    ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
    ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
  };
  const [items, total] = await db.$transaction([
    db.user.findMany({
      where,
      orderBy: [{ enabled: "desc" }, { employeeNo: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        employeeNo: true,
        name: true,
        email: true,
        firstDepartment: true,
        secondDepartment: true,
        position: true,
        workLocation: true,
        status: true,
        enabled: true,
        sourceType: true,
      },
    }),
    db.user.count({ where }),
  ]);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return { items, total, page, pageSize, totalPages };
}

export async function getEmployee(db: PrismaClient, employeeId: string) {
  const employee = await db.user.findFirst({
    where: { id: employeeId, role: Role.EMPLOYEE },
    select: employeeAdminSelect,
  });
  if (!employee) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", "员工不存在");
  return employee;
}

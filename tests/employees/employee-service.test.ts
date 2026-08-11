import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const randomIntMock = vi.hoisted(() => vi.fn<(max: number) => number>());

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: randomIntMock,
}));

import { Role, UserSource, UserStatus, WorkLocation } from "@/generated/prisma/enums";
import {
  bulkSetLocation,
  createEmployee,
  EmployeeServiceError,
  listEmployees,
  resetEmployeePassword,
  setEmployeesEnabled,
  updateEmployee,
} from "@/features/employees/employee-service";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import {
  consumePasswordReset,
  hashPasswordResetToken,
  PasswordResetError,
} from "@/features/auth/password-reset-service";
import { createSession, getActiveSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("employee service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;

  beforeEach(async () => {
    randomIntMock.mockReset();
    testDb = await createTestDatabase();
    actorId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ADMIN-EMP",
          name: "员工管理测试管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("AdminPassword!23"),
        },
      })
    ).id;
  });

  afterEach(async () => testDb.cleanup());

  const validInput = {
    employeeNo: "TEST-301",
    name: "员工甲",
    email: "employee301@example.invalid",
    firstDepartment: "研发中心",
    position: "测试工程师",
    workLocation: WorkLocation.SHANGHAI,
    hiredAt: "2026-07-01",
  };

  it("requires manual accounts to have valid required fields", async () => {
    await expect(
      createEmployee(testDb.db, { ...validInput, email: "" }, actorId),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      createEmployee(testDb.db, { ...validInput, email: "not-an-email" }, actorId),
    ).rejects.toBeInstanceOf(EmployeeServiceError);
    const { hiredAt: _hiredAt, ...withoutHireDate } = validInput;
    void _hiredAt;
    await expect(createEmployee(testDb.db, withoutHireDate as typeof validInput, actorId)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const { workLocation: _workLocation, ...withoutLocation } = validInput;
    void _workLocation;
    await expect(createEmployee(testDb.db, withoutLocation as typeof validInput, actorId)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("creates an employee and reports duplicate employee/email conflicts", async () => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    expect(employee).toMatchObject({
      employeeNo: "TEST-301",
      email: "employee301@example.invalid",
      sourceType: UserSource.MANUAL,
    });
    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } })).mustChangePassword).toBe(true);

    await expect(
      createEmployee(testDb.db, { ...validInput, email: "other@example.invalid" }, actorId),
    ).rejects.toMatchObject({
      code: "DUPLICATE_EMPLOYEE_NO",
      existingUserId: employee.id,
    });
    await expect(
      createEmployee(
        testDb.db,
        { ...validInput, employeeNo: "TEST-302" },
        actorId,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_EMAIL" });
  });

  it("uses the unified initial password and automatically creates an active exam assignment", async () => {
    await testDb.db.exam.create({ data: { name: "自动任务考试", dueDaysAfterHire: 7, enabled: true } });
    const employee = await createEmployee(testDb.db, validInput, actorId);
    const persisted = await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } });
    await expect(verifyPassword("DemoEmployeePass2026", persisted.passwordHash)).resolves.toBe(true);
    const assignment = await testDb.db.examAssignment.findFirstOrThrow({ where: { userId: employee.id } });
    expect(assignment.dueAt.toISOString()).toBe("2026-07-08T00:00:00.000Z");
  });

  it("updates work locations and enabled state in bulk", async () => {
    const first = await createEmployee(testDb.db, validInput, actorId);
    const second = await createEmployee(
      testDb.db,
      {
        ...validInput,
        employeeNo: "TEST-302",
        name: "员工乙",
        email: "employee302@example.invalid",
      },
      actorId,
    );

    expect(
      await bulkSetLocation(
        testDb.db,
        [first.id, second.id],
        WorkLocation.CHANGSHA,
        actorId,
      ),
    ).toBe(2);
    expect(await setEmployeesEnabled(testDb.db, [first.id], false, actorId)).toBe(1);

    const users = await testDb.db.user.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: { employeeNo: "asc" },
    });
    expect(users.map((user) => user.workLocation)).toEqual([
      WorkLocation.CHANGSHA,
      WorkLocation.CHANGSHA,
    ]);
    expect(users.map((user) => user.enabled)).toEqual([false, true]);
  });

  it("permanently invalidates active sessions and reset tokens when employees are disabled", async () => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    const session = await createSession(testDb.db, employee.id);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("employee-disable-token"),
        requestFingerprint: "1".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    expect(await setEmployeesEnabled(testDb.db, [employee.id], false, actorId)).toBe(1);
    expect(await setEmployeesEnabled(testDb.db, [employee.id], true, actorId)).toBe(1);

    expect(await getActiveSession(testDb.db, session.token)).toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "employee-disable-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("does not revoke an administrator credential when a bulk employee request contains a non-employee id", async () => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    const administratorSession = await createSession(testDb.db, actorId);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: actorId,
        tokenHash: hashPasswordResetToken("administrator-token"),
        requestFingerprint: "3".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    expect(
      await setEmployeesEnabled(testDb.db, [employee.id, actorId], false, actorId),
    ).toBe(1);

    expect(await getActiveSession(testDb.db, administratorSession.token)).not.toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: actorId } })).usedAt).toBeNull();
  });

  it.each([UserStatus.DEPARTED, UserStatus.DISABLED])("permanently invalidates active sessions and reset tokens when employee status becomes %s", async (status) => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    const session = await createSession(testDb.db, employee.id);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("employee-departed-token"),
        requestFingerprint: "2".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    await updateEmployee(
      testDb.db,
      employee.id,
      { status },
      actorId,
    );
    await updateEmployee(
      testDb.db,
      employee.id,
      { status: UserStatus.ACTIVE },
      actorId,
    );

    expect(await getActiveSession(testDb.db, session.token)).toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "employee-departed-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("invalidates previously issued reset tokens when an employee email changes", async () => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("employee-email-token"),
        requestFingerprint: "4".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    await updateEmployee(
      testDb.db,
      employee.id,
      { email: "employee301-new@example.invalid" },
      actorId,
    );

    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "employee-email-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("resets a password without replacing the employee record or exam history", async () => {
    const employee = await createEmployee(testDb.db, validInput, actorId);
    const exam = await testDb.db.exam.create({ data: { name: "保留记录测试" } });
    const assignment = await testDb.db.examAssignment.create({
      data: {
        userId: employee.id,
        examId: exam.id,
        dueAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    await testDb.db.examAttempt.create({
      data: {
        assignmentId: assignment.id,
        attemptNo: 1,
        expiresAt: new Date("2026-07-16T10:00:00.000Z"),
        score: 88,
        passed: true,
      },
    });

    let randomCall = 0;
    randomIntMock.mockImplementation((max) => {
      randomCall += 1;
      if (randomCall <= 10) return 0;
      return randomCall % 2 === 0 ? max - 1 : 0;
    });

    const temporaryPassword = await resetEmployeePassword(testDb.db, employee.id, actorId);

    const updated = await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } });
    expect(updated.mustChangePassword).toBe(true);
    expect(temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{10}$/);
    await expect(verifyPassword(temporaryPassword, updated.passwordHash)).resolves.toBe(true);
    expect(await testDb.db.examAttempt.count({ where: { assignmentId: assignment.id } })).toBe(1);
  });

  describe("listEmployees server-side pagination", () => {
    const passwordHash = "test-password-hash";

    async function seedEmployees(count: number) {
      const rows = Array.from({ length: count }, (_, index) => {
        const sequence = String(index + 1).padStart(4, "0");
        const isImported = index % 3 === 0;
        return {
          employeeNo: `PG-${sequence}`,
          name: isImported ? `导入员工${sequence}` : `手工员工${sequence}`,
          email: `pg${sequence}@example.invalid`,
          role: Role.EMPLOYEE,
          sourceType: isImported ? UserSource.EXCEL : UserSource.MANUAL,
          workLocation: index % 2 === 0 ? WorkLocation.SHANGHAI : WorkLocation.SHENZHEN,
          enabled: index % 5 !== 0,
          passwordHash,
          mustChangePassword: false,
        };
      });
      await testDb.db.user.createMany({ data: rows });
    }

    it("paginates after filtering and returns totals for more than 100 mixed-source employees", async () => {
      await seedEmployees(105);

      const pageSize = 20;
      const firstPage = await listEmployees(testDb.db, { page: 1, pageSize });
      expect(firstPage).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 105,
        totalPages: 6,
      });
      expect(firstPage.items).toHaveLength(20);

      const lastPage = await listEmployees(testDb.db, { page: 6, pageSize });
      expect(lastPage).toMatchObject({
        page: 6,
        pageSize: 20,
        total: 105,
        totalPages: 6,
      });
      expect(lastPage.items).toHaveLength(5);
      expect(lastPage.items.every((item) => item.employeeNo.startsWith("PG-"))).toBe(true);

      const sources = new Set(
        (await listEmployees(testDb.db, { page: 1, pageSize: 100 })).items.map((item) => item.sourceType),
      );
      expect(sources.has(UserSource.MANUAL)).toBe(true);
      expect(sources.has(UserSource.EXCEL)).toBe(true);

      const imported = await listEmployees(testDb.db, {
        sourceType: UserSource.EXCEL,
        page: 1,
        pageSize: 100,
      });
      expect(imported.total).toBe(35);
      expect(imported.items.every((item) => item.sourceType === UserSource.EXCEL)).toBe(true);

      const shanghai = await listEmployees(testDb.db, {
        location: WorkLocation.SHANGHAI,
        page: 1,
        pageSize: 50,
      });
      expect(shanghai.total).toBe(53);
      expect(shanghai.totalPages).toBe(2);
      expect(shanghai.items).toHaveLength(50);
      expect(shanghai.items.every((item) => item.workLocation === WorkLocation.SHANGHAI)).toBe(true);

      const disabled = await listEmployees(testDb.db, { enabled: false, page: 1, pageSize: 10 });
      expect(disabled.total).toBe(21);
      expect(disabled.totalPages).toBe(3);
      expect(disabled.items).toHaveLength(10);
      expect(disabled.items.every((item) => item.enabled === false)).toBe(true);

      const searched = await listEmployees(testDb.db, { query: "导入员工", page: 1, pageSize: 100 });
      expect(searched.total).toBe(35);
      expect(searched.items.every((item) => item.name.includes("导入员工"))).toBe(true);

      const byNumber = await listEmployees(testDb.db, { query: "PG-0100", page: 1, pageSize: 10 });
      expect(byNumber.total).toBe(1);
      expect(byNumber.items[0]?.employeeNo).toBe("PG-0100");
    });

    it.each([10, 20, 50, 100] as const)("accepts pageSize %s and rejects other sizes by clamping to allowed values", async (pageSize) => {
      await seedEmployees(101);
      const result = await listEmployees(testDb.db, { page: 1, pageSize });
      expect(result.pageSize).toBe(pageSize);
      expect(result.items).toHaveLength(pageSize);
      expect(result.total).toBe(101);
      expect(result.totalPages).toBe(Math.ceil(101 / pageSize));
    });

    it("defaults pageSize to 20 and coerces invalid page or pageSize inputs", async () => {
      await seedEmployees(25);
      const defaults = await listEmployees(testDb.db, {});
      expect(defaults).toMatchObject({ page: 1, pageSize: 20, total: 25, totalPages: 2 });
      expect(defaults.items).toHaveLength(20);

      const coerced = await listEmployees(testDb.db, {
        page: Number.NaN,
        pageSize: 30 as unknown as number,
      });
      expect(coerced.page).toBe(1);
      expect(coerced.pageSize).toBe(20);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, SessionViewMode, UserSource, UserStatus } from "@/generated/prisma/enums";
import { AuthError } from "@/features/auth/errors";
import { login } from "@/features/auth/login-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("login", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  const now = new Date("2026-07-16T08:00:00.000Z");

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function createUser(input: {
    employeeNo: string;
    name: string;
    password?: string;
    enabled?: boolean;
    status?: UserStatus;
    mustChangePassword?: boolean;
    role?: Role;
  }) {
    return testDb.db.user.create({
      data: {
        employeeNo: input.employeeNo,
        name: input.name,
        passwordHash: await hashPassword(input.password ?? "InitialPass!23"),
        enabled: input.enabled ?? true,
        status: input.status ?? UserStatus.ACTIVE,
        mustChangePassword: input.mustChangePassword ?? true,
        role: input.role ?? Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
      },
    });
  }

  it("allows a unique name and returns the first-login requirement", async () => {
    const user = await createUser({ employeeNo: "TEST-001", name: "测试甲" });

    const result = await login(
      { identifier: "测试甲", password: "InitialPass!23" },
      { db: testDb.db, now: () => now, sessionTtlHours: 12 },
    );

    expect(result.user).toMatchObject({
      id: user.id,
      mustChangePassword: true,
    });
    expect(result.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    const sessions = await testDb.db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).not.toBe(result.sessionToken);
    expect(sessions[0]?.viewMode).toBe(SessionViewMode.EMPLOYEE);
  });

  it.each([Role.ADMIN, Role.SUPER_ADMIN])(
    "starts %s sessions in administrator view",
    async (role) => {
      const user = await createUser({
        employeeNo: `LOGIN-${role}`,
        name: `登录 ${role}`,
        role,
      });

      await login(
        { identifier: user.employeeNo, password: "InitialPass!23" },
        { db: testDb.db, now: () => now },
      );

      await expect(
        testDb.db.session.findFirstOrThrow({ where: { userId: user.id } }),
      ).resolves.toMatchObject({ viewMode: SessionViewMode.ADMIN });
    },
  );

  it("rejects a duplicate name but accepts an employee number", async () => {
    await createUser({ employeeNo: "TEST-002", name: "同名员工" });
    await createUser({ employeeNo: "TEST-003", name: "同名员工" });

    await expect(
      login(
        { identifier: "同名员工", password: "InitialPass!23" },
        { db: testDb.db, now: () => now },
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_IDENTIFIER" });

    await expect(
      login(
        { identifier: "TEST-003", password: "InitialPass!23" },
        { db: testDb.db, now: () => now },
      ),
    ).resolves.toMatchObject({ user: { employeeNo: "TEST-003" } });
  });

  it.each([
    { enabled: false, status: UserStatus.ACTIVE },
    { enabled: true, status: UserStatus.DEPARTED },
  ])("rejects disabled or departed users", async ({ enabled, status }) => {
    await createUser({ employeeNo: "TEST-004", name: "不可登录", enabled, status });

    await expect(
      login(
        { identifier: "TEST-004", password: "InitialPass!23" },
        { db: testDb.db, now: () => now },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("locks the account for 15 minutes after five failed attempts", async () => {
    const user = await createUser({ employeeNo: "TEST-005", name: "锁定测试" });
    const dependencies = {
      db: testDb.db,
      now: () => now,
      maxFailures: 5,
      lockMinutes: 15,
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        login({ identifier: "TEST-005", password: "wrong" }, dependencies),
      ).rejects.toBeInstanceOf(AuthError);
    }

    const locked = await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).toEqual(new Date("2026-07-16T08:15:00.000Z"));
    await expect(
      login({ identifier: "TEST-005", password: "InitialPass!23" }, dependencies),
    ).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
  });

  it("atomically counts concurrent failures and locks at the authoritative threshold", async () => {
    const user = await createUser({ employeeNo: "TEST-005-C", name: "并发锁定测试" });
    let waiting = 0;
    let releaseAttempts!: () => void;
    let markAllWaiting!: () => void;
    const allWaiting = new Promise<void>((resolve) => {
      markAllWaiting = resolve;
    });
    const attemptGate = new Promise<void>((resolve) => {
      releaseAttempts = resolve;
    });
    const dependencies = {
      db: testDb.db,
      now: () => now,
      maxFailures: 5,
      lockMinutes: 15,
      afterPasswordRejected: async () => {
        waiting += 1;
        if (waiting === 5) markAllWaiting();
        await attemptGate;
      },
    };

    const attemptsPromise = Promise.allSettled(
      Array.from({ length: 5 }, () =>
        login({ identifier: user.employeeNo, password: "wrong" }, dependencies),
      ),
    );
    await allWaiting;
    releaseAttempts();
    const attempts = await attemptsPromise;

    expect(attempts).toHaveLength(5);
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    const locked = await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil).toEqual(new Date("2026-07-16T08:15:00.000Z"));

    const audits = await testDb.db.auditLog.findMany({
      where: { actorId: user.id, action: "AUTH_LOGIN", result: "FAILURE" },
      orderBy: { createdAt: "asc" },
    });
    expect(
      audits
        .map((audit) => (audit.metadata as { failureCount?: number }).failureCount)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2, 3, 4, 5]);

    await expect(
      login({ identifier: user.employeeNo, password: "InitialPass!23" }, dependencies),
    ).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(await testDb.db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("starts a new failure window after an account lock expires", async () => {
    const user = await createUser({ employeeNo: "TEST-005-E", name: "过期锁定测试" });
    await testDb.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 5,
        lockedUntil: new Date("2026-07-16T07:59:00.000Z"),
      },
    });
    const dependencies = {
      db: testDb.db,
      now: () => now,
      maxFailures: 5,
      lockMinutes: 15,
    };

    await expect(
      login({ identifier: user.employeeNo, password: "wrong" }, dependencies),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 1,
      lockedUntil: null,
    });

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await expect(
        login({ identifier: user.employeeNo, password: "wrong" }, dependencies),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 4,
      lockedUntil: null,
    });

    await expect(
      login({ identifier: user.employeeNo, password: "wrong" }, dependencies),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 5,
      lockedUntil: new Date("2026-07-16T08:15:00.000Z"),
    });

    const audits = await testDb.db.auditLog.findMany({
      where: { actorId: user.id, action: "AUTH_LOGIN", result: "FAILURE" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((audit) => (audit.metadata as { failureCount?: number }).failureCount)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("atomically starts a new failure window when requests meet an expired lock", async () => {
    const user = await createUser({ employeeNo: "TEST-005-EC", name: "过期并发锁定测试" });
    await testDb.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 5,
        lockedUntil: new Date("2026-07-16T07:59:00.000Z"),
      },
    });
    let waiting = 0;
    let releaseAttempts!: () => void;
    let markAllWaiting!: () => void;
    const allWaiting = new Promise<void>((resolve) => {
      markAllWaiting = resolve;
    });
    const attemptGate = new Promise<void>((resolve) => {
      releaseAttempts = resolve;
    });
    const dependencies = {
      db: testDb.db,
      now: () => now,
      maxFailures: 5,
      lockMinutes: 15,
      afterPasswordRejected: async () => {
        waiting += 1;
        if (waiting === 5) markAllWaiting();
        await attemptGate;
      },
    };

    const attemptsPromise = Promise.allSettled(
      Array.from({ length: 5 }, () =>
        login({ identifier: user.employeeNo, password: "wrong" }, dependencies),
      ),
    );
    await allWaiting;
    releaseAttempts();
    const attempts = await attemptsPromise;

    expect(attempts).toHaveLength(5);
    expect(
      attempts.every(
        (attempt) =>
          attempt.status === "rejected" &&
          attempt.reason instanceof AuthError &&
          attempt.reason.code === "INVALID_CREDENTIALS",
      ),
    ).toBe(true);
    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 5,
      lockedUntil: new Date("2026-07-16T08:15:00.000Z"),
    });

    const audits = await testDb.db.auditLog.findMany({
      where: { actorId: user.id, action: "AUTH_LOGIN", result: "FAILURE" },
    });
    expect(
      audits
        .map((audit) => (audit.metadata as { failureCount?: number }).failureCount)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("allows a correct password after the account lock expires", async () => {
    const user = await createUser({ employeeNo: "TEST-005-ES", name: "过期解锁测试" });
    await testDb.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 5,
        lockedUntil: new Date("2026-07-16T07:59:00.000Z"),
      },
    });

    await expect(
      login(
        { identifier: user.employeeNo, password: "InitialPass!23" },
        { db: testDb.db, now: () => now },
      ),
    ).resolves.toMatchObject({ user: { id: user.id } });
    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
    });
    expect(await testDb.db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("does not penalize a changed password after a rejected password was verified", async () => {
    const user = await createUser({ employeeNo: "TEST-005-P", name: "并发改密测试" });
    const replacementHash = await hashPassword("ChangedPass!456");

    await expect(
      login(
        { identifier: user.employeeNo, password: "wrong" },
        {
          db: testDb.db,
          now: () => now,
          afterPasswordRejected: async () => {
            await testDb.db.user.update({
              where: { id: user.id },
              data: { passwordHash: replacementHash },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      passwordHash: replacementHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await expect(testDb.db.auditLog.findMany({ where: { actorId: user.id } })).resolves.toEqual([
      expect.objectContaining({
        result: "DENIED",
        metadata: { reason: "STALE_CREDENTIALS" },
      }),
    ]);
  });

  it.each([
    { state: "disabled", data: { enabled: false } },
    { state: "departed", data: { status: UserStatus.DEPARTED } },
  ])("does not penalize a user made $state after password rejection", async ({ state, data }) => {
    const user = await createUser({ employeeNo: `TEST-005-${state}`, name: "并发状态测试" });

    await expect(
      login(
        { identifier: user.employeeNo, password: "wrong" },
        {
          db: testDb.db,
          now: () => now,
          afterPasswordRejected: async () => {
            await testDb.db.user.update({ where: { id: user.id }, data });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      ...data,
      failedLoginCount: 0,
      lockedUntil: null,
    });
  });

  it("does not let an in-flight rejected password bypass a newly reached lock", async () => {
    const user = await createUser({ employeeNo: "TEST-005-L", name: "并发到阈值测试" });
    const lockedUntil = new Date("2026-07-16T08:15:00.000Z");

    await expect(
      login(
        { identifier: user.employeeNo, password: "wrong" },
        {
          db: testDb.db,
          now: () => now,
          afterPasswordRejected: async () => {
            await testDb.db.user.update({
              where: { id: user.id },
              data: { failedLoginCount: 5, lockedUntil },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

    await expect(testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      failedLoginCount: 5,
      lockedUntil,
    });
    await expect(testDb.db.auditLog.findMany({ where: { actorId: user.id } })).resolves.toEqual([
      expect.objectContaining({
        result: "DENIED",
        metadata: { reason: "ACCOUNT_LOCKED" },
      }),
    ]);
  });

  it("resets failures after a successful login and keeps audits sanitized", async () => {
    const user = await createUser({ employeeNo: "TEST-006", name: "审计员工" });
    await testDb.db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 3 },
    });

    await login(
      { identifier: "TEST-006", password: "InitialPass!23" },
      { db: testDb.db, now: () => now },
    );

    const updated = await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.failedLoginCount).toBe(0);
    expect(updated.lockedUntil).toBeNull();

    const audits = await testDb.db.auditLog.findMany();
    expect(audits).toEqual([
      expect.objectContaining({
        actorSnapshot: {
          id: user.id,
          employeeNo: "TEST-006",
          name: "审计员工",
          role: Role.EMPLOYEE,
        },
      }),
    ]);
    const metadataText = JSON.stringify(audits.map((audit) => audit.metadata));
    expect(metadataText).not.toContain("InitialPass!23");
    expect(metadataText).not.toContain("审计员工");
    expect(JSON.stringify(audits.map((audit) => audit.actorSnapshot))).not.toContain(
      "example.invalid",
    );
  });

  it("does not create a late session when the password changes after verification", async () => {
    const user = await createUser({ employeeNo: "TEST-007", name: "并发改密员工" });
    const replacementHash = await hashPassword("ChangedPass!456");

    await expect(
      login(
        { identifier: user.employeeNo, password: "InitialPass!23" },
        {
          db: testDb.db,
          now: () => now,
          afterPasswordVerified: async () => {
            await testDb.db.user.update({
              where: { id: user.id },
              data: { passwordHash: replacementHash, mustChangePassword: false },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(await testDb.db.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(testDb.db.auditLog.findMany()).resolves.toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN",
        actorId: user.id,
        result: "DENIED",
        metadata: { reason: "STALE_CREDENTIALS" },
      }),
    ]);
    await expect(
      testDb.db.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).resolves.toMatchObject({
      passwordHash: replacementHash,
      mustChangePassword: false,
    });
  });
});

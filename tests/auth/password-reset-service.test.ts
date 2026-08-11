import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Role, UserSource, UserStatus } from "@/generated/prisma/enums";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import {
  consumePasswordReset,
  hashPasswordResetToken,
  PasswordResetError,
  PASSWORD_RESET_PUBLIC_MESSAGE,
  requestPasswordReset,
} from "@/features/auth/password-reset-service";
import {
  createPasswordResetSender,
  type PasswordResetSender,
} from "@/features/auth/password-reset-sender";
import { createSession } from "@/features/auth/session";
import {
  setEmployeesEnabled,
  updateEmployee,
} from "@/features/employees/employee-service";
import {
  archiveAdminAccount,
  restoreAdminAccount,
} from "@/features/admin-accounts/admin-account-service";
import { createTestDatabase } from "../helpers/test-db";

describe("password reset service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  const now = new Date("2026-07-21T10:00:00.000Z");

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  async function createEmployee() {
    return testDb.db.user.create({
      data: {
        employeeNo: "RECOVERY-001",
        name: "找回密码员工",
        email: "recovery@example.invalid",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("CurrentPass123"),
      },
    });
  }

  function developmentSender(): PasswordResetSender {
    return createPasswordResetSender({
      db: testDb.db,
      env: {
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:3000",
      },
    });
  }

  async function assertResetRequestCannotCrossLifecycle(input: {
    userId: string;
    identifier: string;
    deactivate: () => Promise<unknown>;
    restore: () => Promise<unknown>;
  }) {
    const originalFindFirst = testDb.db.user.findFirst.bind(testDb.db.user);
    vi.spyOn(testDb.db.user, "findFirst").mockImplementationOnce((async (
      args: Parameters<typeof originalFindFirst>[0],
    ) => {
      const user = await originalFindFirst(args);
      await input.deactivate();
      return user;
    }) as never);

    const result = await requestPasswordReset(
      {
        db: testDb.db,
        sender: developmentSender(),
        now: () => now,
        randomBytes: (size) => Buffer.alloc(size, 0x5a),
      },
      { identifier: input.identifier, requestSource: "203.0.113.99" },
    );
    await input.restore();

    expect(result).toMatchObject({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    const token = new URL(result.developmentPreview!.url).searchParams.get("token")!;
    expect(await testDb.db.passwordResetToken.count({ where: { userId: input.userId } })).toBe(0);
    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token, newPassword: "LifecyclePass456" },
      ),
    ).rejects.toMatchObject({ code: "INVALID" } satisfies Partial<PasswordResetError>);
  }

  it("returns the same public shape for known and unknown accounts while making the unknown preview unusable", async () => {
    await createEmployee();
    let randomCall = 0;
    const randomBytes = () => Buffer.alloc(32, ++randomCall);
    const sender = developmentSender();

    const known = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes },
      { identifier: "recovery@example.invalid", requestSource: "203.0.113.10" },
    );
    const unknown = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes },
      { identifier: "missing@example.invalid", requestSource: "203.0.113.10" },
    );

    expect(known.message).toBe(PASSWORD_RESET_PUBLIC_MESSAGE);
    expect(unknown.message).toBe(PASSWORD_RESET_PUBLIC_MESSAGE);
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known.developmentPreview?.label).toBe("开发模拟邮件（非真实发送）");
    expect(unknown.developmentPreview?.label).toBe("开发模拟邮件（非真实发送）");
    expect(known.developmentPreview?.url).not.toBe(unknown.developmentPreview?.url);

    const knownToken = new URL(known.developmentPreview!.url).searchParams.get("token")!;
    const unknownToken = new URL(unknown.developmentPreview!.url).searchParams.get("token")!;
    expect(await testDb.db.passwordResetToken.findUnique({ where: { tokenHash: hashPasswordResetToken(knownToken) } })).not.toBeNull();
    expect(await testDb.db.passwordResetToken.findUnique({ where: { tokenHash: hashPasswordResetToken(unknownToken) } })).toBeNull();
  });

  it.each([
    ["disabled", { enabled: false, status: UserStatus.ACTIVE }],
    ["departed", { enabled: true, status: UserStatus.DEPARTED }],
  ])("does not issue reset tokens for %s accounts and preserves the public anti-enumeration response", async (_label, lifecycle) => {
    const user = await createEmployee();
    await testDb.db.user.update({ where: { id: user.id }, data: lifecycle });
    const send = vi.fn(async () => ({}));
    const sender = {
      mode: "DEVELOPMENT_SIMULATION" as const,
      send,
      createUnusableDevelopmentPreview: (token: string) => ({
        label: "开发模拟邮件（非真实发送）" as const,
        url: `http://localhost:3000/reset-password?token=${token}`,
      }),
    } satisfies PasswordResetSender;
    let randomCall = 0;

    const inactive = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, ++randomCall) },
      { identifier: user.employeeNo, requestSource: "203.0.113.12" },
    );
    const unknown = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, ++randomCall) },
      { identifier: "missing-account", requestSource: "203.0.113.12" },
    );

    expect(inactive).toMatchObject({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    expect(Object.keys(inactive).sort()).toEqual(Object.keys(unknown).sort());
    expect(inactive.developmentPreview?.label).toBe(unknown.developmentPreview?.label);
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.passwordResetToken.count()).toBe(0);
  });

  it("does not issue a token when employee disable commits after the active-account lookup", async () => {
    const user = await createEmployee();
    const actor = await testDb.db.user.create({
      data: {
        employeeNo: "RESET-ACTOR-1",
        name: "reset actor",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("ActorPass123"),
      },
    });

    await assertResetRequestCannotCrossLifecycle({
      userId: user.id,
      identifier: user.employeeNo,
      deactivate: () => setEmployeesEnabled(testDb.db, [user.id], false, actor.id),
      restore: () => setEmployeesEnabled(testDb.db, [user.id], true, actor.id),
    });
  });

  it("does not issue a token when employee departure commits after the active-account lookup", async () => {
    const user = await createEmployee();
    const actor = await testDb.db.user.create({
      data: {
        employeeNo: "RESET-ACTOR-2",
        name: "reset actor",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("ActorPass123"),
      },
    });

    await assertResetRequestCannotCrossLifecycle({
      userId: user.id,
      identifier: user.employeeNo,
      deactivate: () => updateEmployee(
        testDb.db,
        user.id,
        { status: UserStatus.DEPARTED },
        actor.id,
      ),
      restore: () => updateEmployee(
        testDb.db,
        user.id,
        { status: UserStatus.ACTIVE },
        actor.id,
      ),
    });
  });

  it("does not issue a token when administrator archive commits after the active-account lookup", async () => {
    const superAdmin = await testDb.db.user.create({
      data: {
        employeeNo: "RESET-SUPER",
        name: "reset super administrator",
        email: "reset-super@example.invalid",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("SuperPass123"),
        mustChangePassword: false,
      },
    });
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "RESET-ADMIN",
        name: "reset administrator",
        email: "reset-admin@example.invalid",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("AdminPass123"),
        mustChangePassword: false,
      },
    });

    await assertResetRequestCannotCrossLifecycle({
      userId: administrator.id,
      identifier: administrator.employeeNo,
      deactivate: () => archiveAdminAccount(testDb.db, administrator.id, superAdmin.id),
      restore: () => restoreAdminAccount(testDb.db, administrator.id, superAdmin.id),
    });
  });

  it("does not send a usable token to an old mailbox after the account email changes", async () => {
    const user = await createEmployee();
    const originalFindFirst = testDb.db.user.findFirst.bind(testDb.db.user);
    vi.spyOn(testDb.db.user, "findFirst").mockImplementationOnce((async (
      args: Parameters<typeof originalFindFirst>[0],
    ) => {
      const found = await originalFindFirst(args);
      await testDb.db.user.update({
        where: { id: user.id },
        data: { email: "recovery-new@example.invalid" },
      });
      return found;
    }) as never);
    const send = vi.fn(async () => ({}));
    const sender = {
      mode: "DEVELOPMENT_SIMULATION" as const,
      send,
      createUnusableDevelopmentPreview: (token: string) => ({
        label: "开发模拟邮件（非真实发送）" as const,
        url: `http://localhost:3000/reset-password?token=${token}`,
      }),
    } satisfies PasswordResetSender;

    const result = await requestPasswordReset(
      {
        db: testDb.db,
        sender,
        now: () => now,
        randomBytes: (size) => Buffer.alloc(size, 0x6b),
      },
      { identifier: user.email!, requestSource: "203.0.113.100" },
    );

    expect(result).toMatchObject({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("recovery-new@example.invalid");
  });

  it("stores only SHA-256 token hashes and one-way request fingerprints", async () => {
    await createEmployee();
    const rawBytes = Buffer.alloc(32, 0xab);
    const result = await requestPasswordReset(
      { db: testDb.db, sender: developmentSender(), now: () => now, randomBytes: () => rawBytes },
      { identifier: "RECOVERY-001", requestSource: "198.51.100.24" },
    );
    const rawToken = new URL(result.developmentPreview!.url).searchParams.get("token")!;
    const stored = await testDb.db.passwordResetToken.findFirstOrThrow();
    const simulated = await testDb.db.simulatedEmailLog.findFirstOrThrow();

    expect(stored.tokenHash).toBe(createHash("sha256").update(rawToken).digest("hex"));
    expect(stored.tokenHash).not.toContain(rawToken);
    expect(stored.expiresAt).toEqual(new Date(now.getTime() + 30 * 60 * 1_000));
    expect(stored.deliveredAt).toEqual(now);
    expect(stored.deliveryFailedAt).toBeNull();
    expect(stored.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.requestFingerprint).not.toContain("198.51.100.24");
    expect(JSON.stringify(simulated)).not.toContain(rawToken);
    expect(simulated).toMatchObject({
      recipientSnapshot: expect.objectContaining({ employeeNo: "RECOVERY-001" }),
      actorId: null,
      actorSnapshot: null,
      templateKey: "PASSWORD_RESET",
      status: "DEVELOPMENT_SIMULATED",
    });
  });

  it("throttles matching account/source fingerprints after three requests in fifteen minutes", async () => {
    await createEmployee();
    const send = vi.fn(async ({ token }: { token: string }) => ({
      developmentPreview: {
        label: "开发模拟邮件（非真实发送）" as const,
        url: `http://localhost:3000/reset-password?token=${token}`,
      },
    }));
    const sender = {
      mode: "DEVELOPMENT_SIMULATION" as const,
      send,
      createUnusableDevelopmentPreview: (token: string) => ({
        label: "开发模拟邮件（非真实发送）" as const,
        url: `http://localhost:3000/reset-password?token=${token}`,
      }),
    } satisfies PasswordResetSender;
    let sequence = 0;

    for (let index = 0; index < 4; index += 1) {
      await requestPasswordReset(
        { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, ++sequence) },
        { identifier: "RECOVERY-001", requestSource: "203.0.113.7" },
      );
    }

    expect(send).toHaveBeenCalledTimes(3);
    expect(await testDb.db.passwordResetToken.count()).toBe(3);
  });

  it("creates no usable token or readable preview in production without complete SMTP", async () => {
    await createEmployee();
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: { NODE_ENV: "production", APP_BASE_URL: "https://learn.example.com" },
    });
    const result = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, 4) },
      { identifier: "RECOVERY-001", requestSource: "203.0.113.8" },
    );

    expect(result).toEqual({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    expect(await testDb.db.passwordResetToken.count()).toBe(0);
    expect(await testDb.db.simulatedEmailLog.count()).toBe(0);
    expect(await testDb.db.auditLog.findFirstOrThrow()).toMatchObject({
      action: "AUTH_PASSWORD_RESET_REQUEST",
      result: "FAILURE",
      metadata: { reason: "SMTP_NOT_CONFIGURED" },
    });
  });

  it("does not simulate when development SMTP configuration is only partial", async () => {
    await createEmployee();
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: {
        NODE_ENV: "development",
        SMTP_HOST: "smtp.example.invalid",
        SMTP_PORT: "587",
        SMTP_SECURE: "false",
        APP_BASE_URL: "http://localhost:3000",
      },
    });
    const result = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, 8) },
      { identifier: "RECOVERY-001", requestSource: "203.0.113.8" },
    );

    expect(result).toEqual({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    expect(await testDb.db.passwordResetToken.count()).toBe(0);
    expect(await testDb.db.simulatedEmailLog.count()).toBe(0);
  });

  it("maps complete SMTP configuration to Nodemailer and sends with a no-output protocol tracker", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "smtp-message-id" }));
    const createTransport = vi.fn(() => ({ sendMail }));
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: {
        NODE_ENV: "production",
        SMTP_HOST: "smtp.example.invalid",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USERNAME: "smtp-user",
        SMTP_PASSWORD: "smtp-secret",
        SMTP_FROM: "learning@example.invalid",
        APP_BASE_URL: "https://learn.example.invalid",
      },
      createTransport,
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.invalid",
      port: 465,
      secure: true,
      auth: { user: "smtp-user", pass: "smtp-secret" },
      logger: expect.objectContaining({
        trace: expect.any(Function),
        debug: expect.any(Function),
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
        fatal: expect.any(Function),
      }),
      transactionLog: true,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 30_000,
      greetingTimeout: 60_000,
      socketTimeout: 90_000,
    });
    await sender.send({
      recipient: { id: "user-1", employeeNo: "E-1", name: "员工", email: "employee@example.invalid", role: Role.EMPLOYEE },
      token: "raw-token",
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: expect.any(String), address: "learning@example.invalid" },
      envelope: { from: "learning@example.invalid", to: ["employee@example.invalid"] },
      to: { name: "员工", address: "employee@example.invalid" },
      text: expect.stringContaining("https://learn.example.invalid/reset-password?token=raw-token"),
    }));
  });

  it("keeps failed delivery reservations inactive and in throttle history", async () => {
    await createEmployee();
    const sender = {
      mode: "SMTP" as const,
      send: vi.fn(async () => { throw new Error("SMTP unavailable"); }),
    } satisfies PasswordResetSender;

    const result = await requestPasswordReset(
      { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, 9) },
      { identifier: "RECOVERY-001", requestSource: "203.0.113.9" },
    );

    expect(result).toEqual({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    const stored = await testDb.db.passwordResetToken.findFirstOrThrow();
    expect(stored.deliveredAt).toBeNull();
    expect(stored.deliveryFailedAt).toEqual(now);
  });

  it("counts failed deliveries against the three-request quota", async () => {
    await createEmployee();
    const send = vi.fn(async () => { throw new Error("SMTP unavailable"); });
    const sender = { mode: "SMTP" as const, send } satisfies PasswordResetSender;
    let sequence = 0;

    for (let index = 0; index < 4; index += 1) {
      await requestPasswordReset(
        { db: testDb.db, sender, now: () => now, randomBytes: () => Buffer.alloc(32, ++sequence) },
        { identifier: "RECOVERY-001", requestSource: "direct" },
      );
    }

    expect(send).toHaveBeenCalledTimes(3);
    expect(await testDb.db.passwordResetToken.count()).toBe(3);
    expect((await testDb.db.passwordResetToken.findMany()).every((token) => token.deliveryFailedAt?.getTime() === now.getTime())).toBe(true);
  });

  it("fails closed when delivery activation cannot be persisted", async () => {
    await createEmployee();
    const sender = {
      mode: "SMTP" as const,
      send: vi.fn(async () => ({})),
    } satisfies PasswordResetSender;

    await requestPasswordReset(
      {
        db: testDb.db,
        sender,
        now: () => now,
        randomBytes: () => Buffer.alloc(32, 7),
        markDelivered: async () => { throw new Error("activation failed"); },
      },
      { identifier: "RECOVERY-001", requestSource: "direct" },
    );

    const stored = await testDb.db.passwordResetToken.findFirstOrThrow();
    expect(stored.deliveredAt).toBeNull();
    expect(stored.deliveryFailedAt).toEqual(now);
    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: Buffer.alloc(32, 7).toString("base64url"), newPassword: "ChangedPass456" },
      ),
    ).rejects.toMatchObject({ code: "INVALID" } satisfies Partial<PasswordResetError>);
  });

  it("allows only confirmed delivered tokens and rejects inactive or failed tokens", async () => {
    const user = await createEmployee();
    await testDb.db.passwordResetToken.createMany({
      data: [
        { userId: user.id, tokenHash: hashPasswordResetToken("inactive-token"), requestFingerprint: "1".repeat(64), expiresAt: new Date(now.getTime() + 1_000) },
        { userId: user.id, tokenHash: hashPasswordResetToken("failed-token"), requestFingerprint: "2".repeat(64), expiresAt: new Date(now.getTime() + 1_000), deliveryFailedAt: now },
        { userId: user.id, tokenHash: hashPasswordResetToken("delivered-token"), requestFingerprint: "3".repeat(64), expiresAt: new Date(now.getTime() + 1_000), deliveredAt: now },
      ],
    });

    for (const token of ["inactive-token", "failed-token"]) {
      await expect(
        consumePasswordReset(
          { db: testDb.db, now: () => now },
          { token, newPassword: "ChangedPass456" },
        ),
      ).rejects.toMatchObject({ code: "INVALID" } satisfies Partial<PasswordResetError>);
    }
    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "delivered-token", newPassword: "ChangedPass456" },
      ),
    ).resolves.toMatchObject({ userId: user.id });
  });

  it.each([
    ["disabled", { enabled: false, status: UserStatus.ACTIVE }],
    ["departed", { enabled: true, status: UserStatus.DEPARTED }],
  ])("rejects an already delivered token after the account becomes %s without changing security state", async (_label, lifecycle) => {
    const user = await createEmployee();
    const lockedUntil = new Date(now.getTime() + 60_000);
    await testDb.db.user.update({
      where: { id: user.id },
      data: { ...lifecycle, mustChangePassword: true, failedLoginCount: 4, lockedUntil },
    });
    await testDb.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken("lifecycle-token"),
        requestFingerprint: "f".repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        deliveredAt: now,
      },
    });

    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "lifecycle-token", newPassword: "ChangedPass456" },
      ),
    ).rejects.toMatchObject({ code: "INVALID" } satisfies Partial<PasswordResetError>);

    const unchanged = await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged).toMatchObject({
      enabled: lifecycle.enabled,
      status: lifecycle.status,
      mustChangePassword: true,
      failedLoginCount: 4,
      lockedUntil,
    });
    expect(unchanged.passwordHash).toBe(user.passwordHash);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow()).usedAt).toBeNull();
    expect(await testDb.db.auditLog.count({
      where: { action: "AUTH_PASSWORD_RESET", result: "SUCCESS" },
    })).toBe(0);
  });

  it("treats now equal to the thirty-minute expiry as expired", async () => {
    const user = await createEmployee();
    await testDb.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken("boundary-token"),
        requestFingerprint: "a".repeat(64),
        createdAt: new Date("2026-07-21T09:30:00.000Z"),
        expiresAt: now,
        deliveredAt: new Date("2026-07-21T09:30:01.000Z"),
      },
    });

    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "boundary-token", newPassword: "ChangedPass456" },
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" } satisfies Partial<PasswordResetError>);
  });

  it("distinguishes invalid and previously used tokens", async () => {
    const user = await createEmployee();
    await testDb.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken("used-token"),
        requestFingerprint: "9".repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        usedAt: new Date(now.getTime() - 1_000),
        deliveredAt: new Date(now.getTime() - 2_000),
      },
    });

    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "missing-token", newPassword: "ChangedPass456" },
      ),
    ).rejects.toMatchObject({ code: "INVALID" } satisfies Partial<PasswordResetError>);
    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "used-token", newPassword: "ChangedPass456" },
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("consumes a token once under concurrent attempts", async () => {
    const user = await createEmployee();
    await testDb.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken("single-use-token"),
        requestFingerprint: "b".repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        deliveredAt: now,
      },
    });

    const outcomes = await Promise.allSettled([
      consumePasswordReset({ db: testDb.db, now: () => now }, { token: "single-use-token", newPassword: "WinnerPass123" }),
      consumePasswordReset({ db: testDb.db, now: () => now }, { token: "single-use-token", newPassword: "OtherPass456" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow()).usedAt).toEqual(now);
  });

  it("revokes all sessions and other unused reset tokens after a successful reset", async () => {
    const user = await createEmployee();
    await createSession(testDb.db, user.id, { now });
    await testDb.db.passwordResetToken.createMany({
      data: [
        { userId: user.id, tokenHash: hashPasswordResetToken("chosen-token"), requestFingerprint: "c".repeat(64), expiresAt: new Date(now.getTime() + 1_000), deliveredAt: now },
        { userId: user.id, tokenHash: hashPasswordResetToken("other-token"), requestFingerprint: "d".repeat(64), expiresAt: new Date(now.getTime() + 1_000), deliveredAt: now },
      ],
    });

    await consumePasswordReset(
      { db: testDb.db, now: () => now },
      { token: "chosen-token", newPassword: "ChangedPass789" },
    );

    expect((await testDb.db.session.findFirstOrThrow()).revokedAt).toEqual(now);
    expect((await testDb.db.passwordResetToken.findMany()).every((token) => token.usedAt?.getTime() === now.getTime())).toBe(true);
    await expect(verifyPassword("ChangedPass789", (await testDb.db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).resolves.toBe(true);
  });

  it("rejects reuse of the current password without consuming the token", async () => {
    const user = await createEmployee();
    await testDb.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken("reuse-token"),
        requestFingerprint: "e".repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        deliveredAt: now,
      },
    });

    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: "reuse-token", newPassword: "CurrentPass123" },
      ),
    ).rejects.toMatchObject({ code: "PASSWORD_REUSE" } satisfies Partial<PasswordResetError>);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow()).usedAt).toBeNull();
  });
});

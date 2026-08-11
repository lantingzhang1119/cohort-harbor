import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Role, SessionViewMode, UserSource, UserStatus } from "@/generated/prisma/enums";
import { createChangePasswordRoute } from "@/app/api/auth/change-password/route";
import { createForgotPasswordRoute as createForgotPasswordRouteWithSecret } from "@/app/api/auth/forgot-password/route";
import { createLoginRoute } from "@/app/api/auth/login/route";
import { createLogoutRoute } from "@/app/api/auth/logout/route";
import { createResetPasswordRoute as createResetPasswordRouteWithSecret } from "@/app/api/auth/reset-password/route";
import { createViewModeRoute } from "@/app/api/auth/view-mode/route";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import { PASSWORD_RESET_PUBLIC_MESSAGE } from "@/features/auth/password-reset-service";
import { createPasswordResetSender } from "@/features/auth/password-reset-sender";
import { createSession, getActiveSession, hashSessionToken } from "@/features/auth/session";
import {
  hashTestPasswordResetToken as hashPasswordResetToken,
  TEST_AUTH_TOKEN_SECRET,
} from "../helpers/auth-token";
import { createTestDatabase } from "../helpers/test-db";

describe("authentication routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  const now = new Date("2026-07-16T09:00:00.000Z");
  const createForgotPasswordRoute = (
    dependencies: Omit<Parameters<typeof createForgotPasswordRouteWithSecret>[0], "tokenHashSecret">,
  ) => createForgotPasswordRouteWithSecret({ ...dependencies, tokenHashSecret: TEST_AUTH_TOKEN_SECRET });
  const createResetPasswordRoute = (
    dependencies: Omit<Parameters<typeof createResetPasswordRouteWithSecret>[0], "tokenHashSecret">,
  ) => createResetPasswordRouteWithSecret({ ...dependencies, tokenHashSecret: TEST_AUTH_TOKEN_SECRET });

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function createUser(role: Role, mustChangePassword: boolean) {
    return testDb.db.user.create({
      data: {
        employeeNo: role === Role.ADMIN ? "ADMIN-LOCAL" : "TEST-201",
        name: role === Role.ADMIN ? "本地管理员" : "新员工",
        role,
        sourceType: UserSource.MANUAL,
        status: UserStatus.ACTIVE,
        mustChangePassword,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });
  }

  function jsonRequest(path: string, body: object, origin = "http://localhost:3000") {
    return new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  }

  function runBeforeNextTransaction(
    action: () => Promise<void>,
  ): PrismaClient {
    return new Proxy(testDb.db, {
      get(target, property) {
        if (property === "$transaction") {
          return async function interceptedTransaction<T>(
            operation: (transaction: Prisma.TransactionClient) => Promise<T>,
          ): Promise<T> {
            await action();
            return target.$transaction(operation);
          };
        }
        return Reflect.get(target, property, target);
      },
    }) as PrismaClient;
  }

  it("sets a protected local cookie and redirects an administrator", async () => {
    await createUser(Role.ADMIN, false);
    const handler = createLoginRoute({ db: testDb.db, now: () => now });
    const response = await handler(
      jsonRequest("/api/auth/login", {
        identifier: "ADMIN-LOCAL",
        password: "InitialPass!23",
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: "/admin" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("cohort_harbor_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
  });

  it("returns generic invalid-credential copy without a cookie", async () => {
    await createUser(Role.EMPLOYEE, false);
    const handler = createLoginRoute({ db: testDb.db, now: () => now });
    const response = await handler(
      jsonRequest("/api/auth/login", {
        identifier: "TEST-201",
        password: "wrong",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "姓名/工号或密码不正确",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("forces a first-login employee to change the temporary password", async () => {
    await createUser(Role.EMPLOYEE, true);
    const handler = createLoginRoute({ db: testDb.db, now: () => now });
    const response = await handler(
      jsonRequest("/api/auth/login", {
        identifier: "新员工",
        password: "InitialPass!23",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      redirectTo: "/change-password",
    });
  });

  it("changes the password through an authenticated same-origin request", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const token = "a".repeat(64);
    await testDb.db.session.create({
      data: {
        userId: employee.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date("2026-07-17T09:00:00.000Z"),
      },
    });
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("pre-change-reset-token"),
        requestFingerprint: "password-change-test",
        expiresAt: new Date("2026-07-17T09:00:00.000Z"),
        deliveredAt: now,
      },
    });
    const handler = createChangePasswordRoute({ db: testDb.db, now: () => now });
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "InitialPass!23",
      newPassword: "ChangedPass!456",
    });
    request.headers.set("cookie", `cohort_harbor_session=${token}`);
    const response = await handler(request);

    await expect(response.json()).resolves.toEqual({
      ok: true,
      redirectTo: "/employee",
    });
    expect(
      (await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } }))
        .mustChangePassword,
    ).toBe(false);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).toEqual(now);
  });

  it("revokes every other session after a password change while keeping the current session active", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const currentSession = await createSession(testDb.db, employee.id, { now });
    const otherSession = await createSession(testDb.db, employee.id, { now });
    const handler = createChangePasswordRoute({ db: testDb.db, now: () => now });
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "InitialPass!23",
      newPassword: "ChangedPass!456",
    });
    request.headers.set("cookie", `cohort_harbor_session=${currentSession.token}`);

    const response = await handler(request);

    expect(response.status).toBe(200);
    await expect(getActiveSession(testDb.db, currentSession.token, now)).resolves.toMatchObject({
      id: currentSession.sessionId,
      revokedAt: null,
    });
    await expect(getActiveSession(testDb.db, otherSession.token, now)).resolves.toBeNull();
    await expect(
      testDb.db.session.findUniqueOrThrow({ where: { id: otherSession.sessionId } }),
    ).resolves.toMatchObject({ revokedAt: now });
  });

  it("uses the shared password policy and rejects the current password", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const token = "c".repeat(64);
    await testDb.db.session.create({
      data: {
        userId: employee.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date("2026-07-17T09:00:00.000Z"),
      },
    });
    const handler = createChangePasswordRoute({ db: testDb.db, now: () => now });

    for (const newPassword of ["abcdefgh", "12345678", "InitialPass!23"]) {
      const request = jsonRequest("/api/auth/change-password", {
        currentPassword: "InitialPass!23",
        newPassword,
      });
      request.headers.set("cookie", `cohort_harbor_session=${token}`);
      const response = await handler(request);
      expect(response.status).toBe(400);
    }
  });

  it("rejects one of two concurrent change-password requests authorized against the same old hash", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const token = "d".repeat(64);
    await testDb.db.session.create({
      data: {
        userId: employee.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date("2026-07-17T09:00:00.000Z"),
      },
    });
    const handler = createChangePasswordRoute({ db: testDb.db, now: () => now });
    const makeRequest = (newPassword: string) => {
      const request = jsonRequest("/api/auth/change-password", {
        currentPassword: "InitialPass!23",
        newPassword,
      });
      request.headers.set("cookie", `cohort_harbor_session=${token}`);
      return request;
    };

    const responses = await Promise.all([
      handler(makeRequest("ConcurrentPass123")),
      handler(makeRequest("ConcurrentPass456")),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status !== 200)).toHaveLength(1);
    const stored = await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } });
    const matches = await Promise.all([
      verifyPassword("ConcurrentPass123", stored.passwordHash),
      verifyPassword("ConcurrentPass456", stored.passwordHash),
    ]);
    expect(matches.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    "disabled and revoked",
    "departed",
    "revoked session",
    "expired session",
  ] as const)(
    "rejects a password change when the account becomes %s after authentication",
    async (race) => {
      const employee = await createUser(Role.EMPLOYEE, true);
      const currentSession = await createSession(testDb.db, employee.id, { now });
      const otherSession = await createSession(testDb.db, employee.id, { now });
      const db = runBeforeNextTransaction(async () => {
        if (race === "disabled and revoked") {
          await testDb.db.$transaction([
            testDb.db.user.update({
              where: { id: employee.id },
              data: { enabled: false },
            }),
            testDb.db.session.update({
              where: { id: currentSession.sessionId },
              data: { revokedAt: now },
            }),
          ]);
        } else if (race === "departed") {
          await testDb.db.user.update({
            where: { id: employee.id },
            data: { status: UserStatus.DEPARTED },
          });
        } else if (race === "revoked session") {
          await testDb.db.session.update({
            where: { id: currentSession.sessionId },
            data: { revokedAt: now },
          });
        } else {
          await testDb.db.session.update({
            where: { id: currentSession.sessionId },
            data: { expiresAt: now },
          });
        }
      });
      const handler = createChangePasswordRoute({ db, now: () => now });
      const request = jsonRequest("/api/auth/change-password", {
        currentPassword: "InitialPass!23",
        newPassword: "ChangedPass!456",
      });
      request.headers.set("cookie", `cohort_harbor_session=${currentSession.token}`);

      const response = await handler(request);

      expect(response.status).toBe(401);
      const stored = await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } });
      await expect(verifyPassword("InitialPass!23", stored.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword("ChangedPass!456", stored.passwordHash)).resolves.toBe(false);
      expect(stored.mustChangePassword).toBe(true);
      await expect(
        testDb.db.session.findUniqueOrThrow({ where: { id: otherSession.sessionId } }),
      ).resolves.toMatchObject({ revokedAt: null });
      expect(await testDb.db.auditLog.count({
        where: {
          action: "AUTH_PASSWORD_CHANGE",
          result: "SUCCESS",
          targetId: employee.id,
        },
      })).toBe(0);
    },
  );

  it("rejects a password change without overwriting a concurrently changed session view", async () => {
    const administrator = await createUser(Role.ADMIN, true);
    const currentSession = await createSession(testDb.db, administrator.id, {
      now,
      viewMode: SessionViewMode.ADMIN,
    });
    const db = runBeforeNextTransaction(async () => {
      await testDb.db.session.update({
        where: { id: currentSession.sessionId },
        data: { viewMode: SessionViewMode.EMPLOYEE },
      });
    });
    const handler = createChangePasswordRoute({ db, now: () => now });
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "InitialPass!23",
      newPassword: "ChangedPass!456",
    });
    request.headers.set("cookie", `cohort_harbor_session=${currentSession.token}`);

    const response = await handler(request);

    expect(response.status).toBe(401);
    await expect(
      testDb.db.session.findUniqueOrThrow({ where: { id: currentSession.sessionId } }),
    ).resolves.toMatchObject({
      userId: administrator.id,
      viewMode: SessionViewMode.EMPLOYEE,
      revokedAt: null,
    });
    const stored = await testDb.db.user.findUniqueOrThrow({ where: { id: administrator.id } });
    await expect(verifyPassword("InitialPass!23", stored.passwordHash)).resolves.toBe(true);
  });

  it("rejects a password change when the authenticated session identity changes", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const administrator = await createUser(Role.ADMIN, false);
    const currentSession = await createSession(testDb.db, employee.id, { now });
    const db = runBeforeNextTransaction(async () => {
      await testDb.db.session.update({
        where: { id: currentSession.sessionId },
        data: { userId: administrator.id },
      });
    });
    const handler = createChangePasswordRoute({ db, now: () => now });
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "InitialPass!23",
      newPassword: "ChangedPass!456",
    });
    request.headers.set("cookie", `cohort_harbor_session=${currentSession.token}`);

    const response = await handler(request);

    expect(response.status).toBe(401);
    await expect(
      testDb.db.session.findUniqueOrThrow({ where: { id: currentSession.sessionId } }),
    ).resolves.toMatchObject({ userId: administrator.id });
    const stored = await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } });
    await expect(verifyPassword("InitialPass!23", stored.passwordHash)).resolves.toBe(true);
    expect(await testDb.db.auditLog.count({
      where: { action: "AUTH_PASSWORD_CHANGE", result: "SUCCESS" },
    })).toBe(0);
  });

  it("rejects a password change when the stored hash changes even if the current password still matches", async () => {
    const employee = await createUser(Role.EMPLOYEE, true);
    const currentSession = await createSession(testDb.db, employee.id, { now });
    const otherSession = await createSession(testDb.db, employee.id, { now });
    const replacementHash = await hashPassword("InitialPass!23");
    const db = runBeforeNextTransaction(async () => {
      await testDb.db.user.update({
        where: { id: employee.id },
        data: { passwordHash: replacementHash },
      });
    });
    const handler = createChangePasswordRoute({ db, now: () => now });
    const request = jsonRequest("/api/auth/change-password", {
      currentPassword: "InitialPass!23",
      newPassword: "ChangedPass!456",
    });
    request.headers.set("cookie", `cohort_harbor_session=${currentSession.token}`);

    const response = await handler(request);

    expect(response.status).toBe(409);
    await expect(
      testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } }),
    ).resolves.toMatchObject({ passwordHash: replacementHash, mustChangePassword: true });
    await expect(
      testDb.db.session.findUniqueOrThrow({ where: { id: otherSession.sessionId } }),
    ).resolves.toMatchObject({ revokedAt: null });
    expect(await testDb.db.auditLog.count({
      where: { action: "AUTH_PASSWORD_CHANGE", result: "SUCCESS" },
    })).toBe(0);
  });

  it("keeps forgot-password status, copy, and keys uniform for known and unknown identifiers", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    await testDb.db.user.update({ where: { id: employee.id }, data: { email: "route-recovery@example.invalid" } });
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: { NODE_ENV: "development", APP_BASE_URL: "http://localhost:3000" },
    });
    const handler = createForgotPasswordRoute({
      db: testDb.db,
      sender,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 5),
    });

    const known = await handler(jsonRequest("/api/auth/forgot-password", { identifier: "route-recovery@example.invalid" }));
    const unknown = await handler(jsonRequest("/api/auth/forgot-password", { identifier: "unknown@example.invalid" }));
    const knownBody = await known.json();
    const unknownBody = await unknown.json();

    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(knownBody.message).toBe(PASSWORD_RESET_PUBLIC_MESSAGE);
    expect(unknownBody.message).toBe(PASSWORD_RESET_PUBLIC_MESSAGE);
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
  });

  it("returns the production response before deferred account and SMTP work starts", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    await testDb.db.user.update({ where: { id: employee.id }, data: { email: "deferred@example.invalid" } });
    const send = vi.fn(async () => ({}));
    const sender = { mode: "SMTP" as const, send };
    let deferred: (() => Promise<void>) | undefined;
    const handler = createForgotPasswordRoute({
      db: testDb.db,
      sender,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 11),
      defer: (work) => { deferred = work; },
    });

    const response = await handler(jsonRequest("/api/auth/forgot-password", { identifier: "deferred@example.invalid" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.passwordResetToken.count()).toBe(0);

    await deferred!();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow()).deliveredAt).toEqual(now);
  });

  it("keeps deferred production processing failures generic and HTTP 200", async () => {
    const sender = { mode: "SMTP" as const, send: vi.fn(async () => ({})) };
    let deferred: (() => Promise<void>) | undefined;
    const failingDb = {
      user: { findFirst: vi.fn(async () => { throw new Error("database unavailable"); }) },
    } as unknown as typeof testDb.db;
    const handler = createForgotPasswordRoute({
      db: failingDb,
      sender,
      defer: (work) => { deferred = work; },
    });

    const response = await handler(jsonRequest("/api/auth/forgot-password", { identifier: "any@example.invalid" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE });
    await expect(deferred!()).resolves.toBeUndefined();
  });

  it("ignores spoofed forwarding headers for the default source bucket", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    await testDb.db.user.update({ where: { id: employee.id }, data: { email: "source@example.invalid" } });
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: { NODE_ENV: "development", APP_BASE_URL: "http://localhost:3000" },
    });
    let sequence = 0;
    const handler = createForgotPasswordRoute({
      db: testDb.db,
      sender,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, ++sequence),
    });

    for (let index = 0; index < 4; index += 1) {
      const request = jsonRequest("/api/auth/forgot-password", { identifier: "source@example.invalid" });
      request.headers.set("x-forwarded-for", `203.0.113.${index + 1}`);
      const response = await handler(request);
      expect(response.status).toBe(200);
    }
    expect(await testDb.db.passwordResetToken.count()).toBe(3);
    expect(new Set((await testDb.db.passwordResetToken.findMany()).map((token) => token.requestFingerprint)).size).toBe(1);
  });

  it("keeps an empty forgot-password submission generic", async () => {
    const sender = createPasswordResetSender({
      db: testDb.db,
      env: { NODE_ENV: "development", APP_BASE_URL: "http://localhost:3000" },
    });
    const handler = createForgotPasswordRoute({
      db: testDb.db,
      sender,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 6),
    });

    const response = await handler(jsonRequest("/api/auth/forgot-password", { identifier: "" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message: PASSWORD_RESET_PUBLIC_MESSAGE,
      developmentPreview: {
        label: "开发模拟邮件（非真实发送）",
        url: expect.stringContaining("/reset-password?token="),
      },
    });
  });

  it("redacts token and password from reset responses", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("route-reset-token"),
        requestFingerprint: "f".repeat(64),
        expiresAt: new Date(now.getTime() + 1_000),
        deliveredAt: now,
      },
    });
    const handler = createResetPasswordRoute({ db: testDb.db, now: () => now });
    const response = await handler(jsonRequest("/api/auth/reset-password", {
      token: "route-reset-token",
      newPassword: "RouteChanged123",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, message: "密码已重置，请使用新密码登录" });
    expect(JSON.stringify(body)).not.toContain("route-reset-token");
    expect(JSON.stringify(body)).not.toContain("RouteChanged123");
  });

  it("revokes logout and rejects cross-origin mutations", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    const token = "b".repeat(64);
    await testDb.db.session.create({
      data: {
        userId: employee.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date("2026-07-17T09:00:00.000Z"),
      },
    });
    const logout = createLogoutRoute({ db: testDb.db, now: () => now });
    const request = jsonRequest("/api/auth/logout", {});
    request.headers.set("cookie", `cohort_harbor_session=${token}`);
    const response = await logout(request);
    expect(response.status).toBe(200);
    expect((await testDb.db.session.findFirstOrThrow()).revokedAt).toEqual(now);

    const loginHandler = createLoginRoute({ db: testDb.db, now: () => now });
    const denied = await loginHandler(
      jsonRequest(
        "/api/auth/login",
        { identifier: "TEST-201", password: "InitialPass!23" },
        "https://attacker.invalid",
      ),
    );
    expect(denied.status).toBe(403);
  });

  it("switches an administrator view through an authenticated same-origin POST", async () => {
    const administrator = await createUser(Role.ADMIN, false);
    const created = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    const handler = createViewModeRoute({ db: testDb.db });
    const request = jsonRequest("/api/auth/view-mode", {
      targetMode: SessionViewMode.EMPLOYEE,
    });
    request.headers.set("cookie", `cohort_harbor_session=${created.token}`);

    const response = await handler(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: "/employee" });
    expect(await testDb.db.session.count()).toBe(1);
    expect(await testDb.db.session.findFirstOrThrow()).toMatchObject({
      userId: administrator.id,
      viewMode: SessionViewMode.EMPLOYEE,
    });
  });

  it("denies employee ADMIN switching and cross-origin view-mode POSTs", async () => {
    const employee = await createUser(Role.EMPLOYEE, false);
    const employeeSession = await createSession(testDb.db, employee.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const handler = createViewModeRoute({ db: testDb.db });
    const employeeRequest = jsonRequest("/api/auth/view-mode", {
      targetMode: SessionViewMode.ADMIN,
    });
    employeeRequest.headers.set("cookie", `cohort_harbor_session=${employeeSession.token}`);
    expect((await handler(employeeRequest)).status).toBe(403);

    const administrator = await createUser(Role.ADMIN, false);
    const administratorSession = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    const crossOrigin = jsonRequest(
      "/api/auth/view-mode",
      { targetMode: SessionViewMode.EMPLOYEE },
      "https://attacker.invalid",
    );
    crossOrigin.headers.set("cookie", `cohort_harbor_session=${administratorSession.token}`);
    expect((await handler(crossOrigin)).status).toBe(403);
    expect(
      await testDb.db.session.findUniqueOrThrow({
        where: { tokenHash: hashSessionToken(administratorSession.token) },
      }),
    ).toMatchObject({ viewMode: SessionViewMode.ADMIN });
  });
});

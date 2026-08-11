import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role, SessionViewMode, UserSource, UserStatus } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession, hashSessionToken, revokeSession } from "@/features/auth/session";
import { switchSessionViewMode } from "@/features/auth/view-mode-service";
import { createTestDatabase } from "../helpers/test-db";

describe("session view-mode service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function createUser(role: Role, suffix: string) {
    return testDb.db.user.create({
      data: {
        employeeNo: `${role}-${suffix}`,
        name: `${role}-${suffix}`,
        role,
        sourceType: UserSource.MANUAL,
        status: UserStatus.ACTIVE,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass123"),
      },
    });
  }

  function withInterleavedMutation(beforeMutation: () => Promise<void>): PrismaClient {
    let fired = false;
    const session = new Proxy(testDb.db.session, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "update" || property === "updateMany") {
          return async (...args: unknown[]) => {
            if (!fired) {
              fired = true;
              await beforeMutation();
            }
            return Reflect.apply(value as (...parameters: unknown[]) => unknown, target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(testDb.db, {
      get(target, property) {
        if (property === "session") return session;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
  }

  it.each([Role.ADMIN, Role.SUPER_ADMIN])(
    "switches a %s session ADMIN to EMPLOYEE and back without changing identity or session count",
    async (role) => {
      const administrator = await createUser(role, "switch");
      const created = await createSession(testDb.db, administrator.id, {
        viewMode: SessionViewMode.ADMIN,
      });
      const other = await createSession(testDb.db, administrator.id, {
        viewMode: SessionViewMode.ADMIN,
      });
      const before = await testDb.db.session.findMany({ orderBy: { id: "asc" } });

      await expect(
        switchSessionViewMode(testDb.db, created.token, SessionViewMode.EMPLOYEE),
      ).resolves.toEqual({ redirectTo: "/employee" });
      const employeeView = await testDb.db.session.findUniqueOrThrow({
        where: { tokenHash: hashSessionToken(created.token) },
      });
      expect(employeeView).toMatchObject({
        userId: administrator.id,
        viewMode: SessionViewMode.EMPLOYEE,
      });
      expect(
        await testDb.db.session.findUniqueOrThrow({
          where: { tokenHash: hashSessionToken(other.token) },
        }),
      ).toMatchObject({ viewMode: SessionViewMode.ADMIN });

      await expect(
        switchSessionViewMode(testDb.db, created.token, SessionViewMode.ADMIN),
      ).resolves.toEqual({ redirectTo: "/admin" });
      const after = await testDb.db.session.findMany({ orderBy: { id: "asc" } });
      expect(after).toHaveLength(before.length);
      expect(after.map(({ id, userId }) => ({ id, userId }))).toEqual(
        before.map(({ id, userId }) => ({ id, userId })),
      );
    },
  );

  it.each([Role.ADMIN, Role.SUPER_ADMIN])(
    "blocks a %s placeholder identity from entering employee view",
    async (role) => {
      const administrator = await createUser(role, "reserved-name");
      await testDb.db.user.update({
        where: { id: administrator.id },
        data: { name: " 系统管理员 " },
      });
      const created = await createSession(testDb.db, administrator.id, {
        viewMode: SessionViewMode.ADMIN,
      });

      await expect(
        switchSessionViewMode(testDb.db, created.token, SessionViewMode.EMPLOYEE),
      ).rejects.toMatchObject({ code: "REAL_NAME_REQUIRED", status: 409 });
      expect(
        await testDb.db.session.findUniqueOrThrow({
          where: { tokenHash: hashSessionToken(created.token) },
        }),
      ).toMatchObject({ viewMode: SessionViewMode.ADMIN });
    },
  );

  it("allows an employee to remain in EMPLOYEE mode but rejects ADMIN mode", async () => {
    const employee = await createUser(Role.EMPLOYEE, "employee");
    const created = await createSession(testDb.db, employee.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });

    await expect(
      switchSessionViewMode(testDb.db, created.token, SessionViewMode.EMPLOYEE),
    ).resolves.toEqual({ redirectTo: "/employee" });
    await expect(
      switchSessionViewMode(testDb.db, created.token, SessionViewMode.ADMIN),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(
      await testDb.db.session.findUniqueOrThrow({
        where: { tokenHash: hashSessionToken(created.token) },
      }),
    ).toMatchObject({ userId: employee.id, viewMode: SessionViewMode.EMPLOYEE });
  });

  it("rejects expired, revoked, and disabled sessions without mutating their mode", async () => {
    const expiredUser = await createUser(Role.ADMIN, "expired");
    const expired = await createSession(testDb.db, expiredUser.id, {
      now: new Date("2000-01-01T00:00:00.000Z"),
      ttlHours: 1,
      viewMode: SessionViewMode.ADMIN,
    });
    const revokedUser = await createUser(Role.ADMIN, "revoked");
    const revoked = await createSession(testDb.db, revokedUser.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    await revokeSession(testDb.db, revoked.token);
    const disabledUser = await createUser(Role.ADMIN, "disabled");
    const disabled = await createSession(testDb.db, disabledUser.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    await testDb.db.user.update({ where: { id: disabledUser.id }, data: { enabled: false } });

    for (const token of [expired.token, revoked.token, disabled.token]) {
      await expect(
        switchSessionViewMode(testDb.db, token, SessionViewMode.EMPLOYEE),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    }
    expect(
      await testDb.db.session.count({ where: { viewMode: SessionViewMode.EMPLOYEE } }),
    ).toBe(0);
  });

  it.each([
    {
      name: "revocation",
      expectedCode: "UNAUTHENTICATED",
      mutate: async (userId: string, token: string) => {
        void userId;
        await revokeSession(testDb.db, token);
      },
    },
    {
      name: "disable",
      expectedCode: "UNAUTHENTICATED",
      mutate: async (userId: string) => {
        await testDb.db.user.update({ where: { id: userId }, data: { enabled: false } });
      },
    },
    {
      name: "role demotion",
      expectedCode: "FORBIDDEN",
      mutate: async (userId: string) => {
        await testDb.db.user.update({ where: { id: userId }, data: { role: Role.EMPLOYEE } });
      },
    },
  ])(
    "does not switch after interleaved $name between preliminary read and mutation",
    async ({ name, expectedCode, mutate }) => {
      const administrator = await createUser(Role.ADMIN, `interleaved-${name}`);
      const created = await createSession(testDb.db, administrator.id, {
        viewMode: SessionViewMode.EMPLOYEE,
      });
      const wrapped = withInterleavedMutation(() => mutate(administrator.id, created.token));

      await expect(
        switchSessionViewMode(wrapped, created.token, SessionViewMode.ADMIN),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(
        await testDb.db.session.findUniqueOrThrow({
          where: { tokenHash: hashSessionToken(created.token) },
        }),
      ).toMatchObject({ viewMode: SessionViewMode.EMPLOYEE });
    },
  );
});

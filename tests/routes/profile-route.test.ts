import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProfileRoute } from "@/app/api/auth/profile/route";
import { Role, SessionViewMode, UserSource, UserStatus } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("self profile route", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function createUser(role: Role, employeeNo: string, name: string) {
    return testDb.db.user.create({
      data: {
        employeeNo,
        name,
        role,
        sourceType: UserSource.MANUAL,
        status: UserStatus.ACTIVE,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass123"),
      },
    });
  }

  function request(token: string, name: string, origin = "http://localhost:3000") {
    return new Request("http://localhost:3000/api/auth/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `cohort_harbor_session=${token}`,
        origin,
      },
      body: JSON.stringify({ name }),
    });
  }

  it.each([SessionViewMode.ADMIN, SessionViewMode.EMPLOYEE])(
    "updates an administrator in %s view without accepting a target account id",
    async (viewMode) => {
      const administrator = await createUser(Role.ADMIN, `ADMIN-${viewMode}`, "系统管理员");
      const session = await createSession(testDb.db, administrator.id, { viewMode });
      const handler = createProfileRoute({ db: testDb.db });

      const response = await handler(request(session.token, "示例员工"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        name: "示例员工",
        redirectTo: viewMode === SessionViewMode.ADMIN ? "/admin/settings" : "/employee",
      });
      expect(await testDb.db.user.findUniqueOrThrow({ where: { id: administrator.id } }))
        .toMatchObject({ name: "示例员工" });
    },
  );

  it("rejects employee use, reserved names, cross-origin mutation, and unauthenticated mutation", async () => {
    const employee = await createUser(Role.EMPLOYEE, "EMP-PROFILE", "新员工");
    const employeeSession = await createSession(testDb.db, employee.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const administrator = await createUser(Role.ADMIN, "ADMIN-PROFILE", "系统管理员");
    const adminSession = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    const handler = createProfileRoute({ db: testDb.db });

    expect((await handler(request(employeeSession.token, "员工自改"))).status).toBe(403);
    expect((await handler(request(adminSession.token, "超级管理员"))).status).toBe(400);
    expect((await handler(request(adminSession.token, "示例员工", "https://attacker.invalid"))).status).toBe(403);
    expect((await handler(request("missing", "示例员工"))).status).toBe(401);
    expect(await testDb.db.auditLog.count()).toBe(0);
  });
});

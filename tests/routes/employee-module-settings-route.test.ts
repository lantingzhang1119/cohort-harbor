import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmployeeModuleSettingsRoute } from "@/app/api/admin/settings/employee-modules/route";
import { EmployeeModuleKey, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("employee module settings route", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  const tokens = new Map<string, string>();

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass123");
    for (const [name, role, viewMode] of [
      ["admin", Role.ADMIN, SessionViewMode.ADMIN],
      ["super", Role.SUPER_ADMIN, SessionViewMode.ADMIN],
      ["employee", Role.EMPLOYEE, SessionViewMode.EMPLOYEE],
      ["admin-employee-view", Role.ADMIN, SessionViewMode.EMPLOYEE],
    ] as const) {
      const user = await testDb.db.user.create({
        data: {
          employeeNo: `MODULE-ROUTE-${name}`,
          name,
          role,
          sourceType: UserSource.MANUAL,
          mustChangePassword: false,
          passwordHash,
        },
      });
      tokens.set(name, (await createSession(testDb.db, user.id, { viewMode })).token);
    }
  });

  afterEach(async () => testDb.cleanup());

  function request(name: string, method: "GET" | "PATCH", body?: unknown, origin = "http://localhost:3000") {
    return new Request("http://localhost:3000/api/admin/settings/employee-modules", {
      method,
      headers: {
        cookie: `cohort_harbor_session=${tokens.get(name)}`,
        origin,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it.each(["admin", "super"])("gives %s the same read and update permission", async (name) => {
    const route = createEmployeeModuleSettingsRoute({ db: testDb.db });
    expect((await route.GET(request(name, "GET"))).status).toBe(200);
    const response = await route.PATCH(request(name, "PATCH", {
      enabledKeys: [EmployeeModuleKey.GUIDES, EmployeeModuleKey.ONBOARDING_KIT],
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      enabledKeys: [EmployeeModuleKey.GUIDES, EmployeeModuleKey.ONBOARDING_KIT],
    });
  });

  it("rejects employee views, cross-origin writes, duplicates and unknown keys without mutation", async () => {
    const route = createEmployeeModuleSettingsRoute({ db: testDb.db });
    expect((await route.GET(request("employee", "GET"))).status).toBe(403);
    expect((await route.GET(request("admin-employee-view", "GET"))).status).toBe(403);
    expect((await route.PATCH(request("admin", "PATCH", {
      enabledKeys: [EmployeeModuleKey.GUIDES],
    }, "https://attacker.invalid"))).status).toBe(403);
    expect((await route.PATCH(request("admin", "PATCH", {
      enabledKeys: [EmployeeModuleKey.GUIDES, EmployeeModuleKey.GUIDES],
    }))).status).toBe(400);
    expect((await route.PATCH(request("admin", "PATCH", {
      enabledKeys: ["UNKNOWN"],
    }))).status).toBe(400);
    expect((await testDb.db.employeeModuleSetting.count({ where: { enabled: true } }))).toBe(7);
    expect(await testDb.db.auditLog.count()).toBe(0);
  });
});

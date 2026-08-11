import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStartRoute } from "@/app/api/exam/start/route";
import { createGuidesRoute } from "@/app/api/guides/route";
import { createNotificationsRoute } from "@/app/api/notifications/route";
import { createOnboardingKitRoute } from "@/app/api/onboarding-kit/route";
import { createPoliciesRoute } from "@/app/api/policies/route";
import { createExamResultsRoute } from "@/app/api/exam/results/route";
import { createRetakesRoute } from "@/app/api/retakes/route";
import {
  EmployeeModuleKey,
  Role,
  SessionViewMode,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("employee module API enforcement", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let employeeToken: string;
  let adminEmployeeToken: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass123");
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "MODULE-API-EMP",
        name: "接口员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "MODULE-API-ADMIN",
        name: "接口管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    employeeId = employee.id;
    employeeToken = (await createSession(testDb.db, employee.id)).token;
    adminEmployeeToken = (await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    })).token;
  });

  afterEach(async () => testDb.cleanup());

  function request(
    path: string,
    token = employeeToken,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        ...(method === "GET" ? {} : {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it.each([
    [EmployeeModuleKey.GUIDES, "/api/guides", (req: Request) => createGuidesRoute({ db: testDb.db }).GET(req)],
    [EmployeeModuleKey.ONBOARDING_KIT, "/api/onboarding-kit", (req: Request) => createOnboardingKitRoute({ db: testDb.db }).GET(req)],
    [EmployeeModuleKey.POLICIES, "/api/policies", (req: Request) => createPoliciesRoute({ db: testDb.db }).GET(req)],
    [EmployeeModuleKey.EXAM, "/api/exam/start", (req: Request) => createStartRoute({ db: testDb.db })(req)],
    [EmployeeModuleKey.RESULTS, "/api/exam/results", (req: Request) => createExamResultsRoute({ db: testDb.db }).GET(req)],
    [EmployeeModuleKey.RETAKE, "/api/retakes", (req: Request) => createRetakesRoute({ db: testDb.db }).GET(req)],
    [EmployeeModuleKey.NOTIFICATIONS, "/api/notifications", (req: Request) => createNotificationsRoute({ db: testDb.db }).GET(req)],
  ] as const)("returns 403 for a disabled %s API", async (key, path, call) => {
    await testDb.db.employeeModuleSetting.update({ where: { key }, data: { enabled: false } });
    const method = key === EmployeeModuleKey.EXAM ? "POST" : "GET";
    const response = await call(request(path, employeeToken, method));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "该板块当前未开放",
    });
  });

  it("applies the same disabled API decision to an administrator in employee view", async () => {
    await testDb.db.employeeModuleSetting.update({
      where: { key: EmployeeModuleKey.GUIDES },
      data: { enabled: false },
    });
    const response = await createGuidesRoute({ db: testDb.db }).GET(
      request("/api/guides", adminEmployeeToken),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 from an employee module API until the employee changes the temporary password", async () => {
    const employee = await testDb.db.user.findUniqueOrThrow({
      where: { employeeNo: "MODULE-API-EMP" },
    });
    await testDb.db.user.update({
      where: { id: employee.id },
      data: { mustChangePassword: true },
    });

    const response = await createGuidesRoute({ db: testDb.db }).GET(
      request("/api/guides", employeeToken),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "请先修改初始密码",
    });
  });

  it("marks only the current employee notification as read", async () => {
    const own = await testDb.db.notification.create({
      data: {
        userId: employeeId,
        type: "SYSTEM",
        title: "自己的通知",
        body: "正文",
      },
    });
    const administrator = await testDb.db.user.findUniqueOrThrow({
      where: { employeeNo: "MODULE-API-ADMIN" },
    });
    const other = await testDb.db.notification.create({
      data: {
        userId: administrator.id,
        type: "SYSTEM",
        title: "别人的通知",
        body: "正文",
      },
    });
    const route = createNotificationsRoute({ db: testDb.db });
    const changed = await route.PATCH(
      request("/api/notifications", employeeToken, "PATCH", { id: own.id }),
    );
    expect(changed.status).toBe(200);
    expect((await testDb.db.notification.findUniqueOrThrow({ where: { id: own.id } })).readAt)
      .not.toBeNull();
    const denied = await route.PATCH(
      request("/api/notifications", employeeToken, "PATCH", { id: other.id }),
    );
    await expect(denied.json()).resolves.toMatchObject({ ok: true, changed: 0 });
    expect((await testDb.db.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt)
      .toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, SessionViewMode, UserSource, WorkLocation } from "@/generated/prisma/enums";
import { createEmployeesRoute } from "@/app/api/admin/employees/route";
import { createBulkLocationRoute } from "@/app/api/admin/employees/bulk-location/route";
import { createResetPasswordRoute } from "@/app/api/admin/employees/[id]/reset-password/route";
import { createEmployeeDetailRoute } from "@/app/api/admin/employees/[id]/route";
import { hashPassword } from "@/features/auth/password";
import { verifyPassword } from "@/features/auth/password";
import { createSession, hashSessionToken } from "@/features/auth/session";
import { resetEmployeePassword } from "@/features/employees/employee-service";
import { hashTestPasswordResetToken as hashPasswordResetToken } from "../helpers/auth-token";
import { createTestDatabase } from "../helpers/test-db";

describe("employee administration routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminToken: string;
  let employeeToken: string;
  let targetId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-ROUTE",
        name: "路由管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-401",
        name: "普通员工",
        email: "employee401@example.invalid",
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    targetId = employee.id;
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id)).token;
  });

  afterEach(async () => testDb.cleanup());

  function request(path: string, token: string, body?: object) {
    return new Request(`http://localhost:3000${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin: "http://localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("paginates the employee list with pageSize and totalPages from the query string", async () => {
    const passwordHash = await hashPassword("BulkPass!23");
    await testDb.db.user.createMany({
      data: Array.from({ length: 105 }, (_, index) => {
        const sequence = String(index + 1).padStart(4, "0");
        return {
          employeeNo: `RT-${sequence}`,
          name: index % 2 === 0 ? `路由导入${sequence}` : `路由手工${sequence}`,
          email: `route-pg${sequence}@example.invalid`,
          role: Role.EMPLOYEE,
          sourceType: index % 2 === 0 ? UserSource.EXCEL : UserSource.MANUAL,
          workLocation: WorkLocation.SHANGHAI,
          passwordHash,
          mustChangePassword: false,
        };
      }),
    });

    const employees = createEmployeesRoute({ db: testDb.db });
    const response = await employees.GET(
      request("/api/admin/employees?page=6&pageSize=20&location=SHANGHAI", adminToken),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      page: 6,
      pageSize: 20,
      total: 105,
      totalPages: 6,
    });
    expect(body.items).toHaveLength(5);
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    const firstPage = await (
      await employees.GET(request("/api/admin/employees?page=1&pageSize=10", adminToken))
    ).json();
    expect(firstPage).toMatchObject({ ok: true, page: 1, pageSize: 10, total: 106, totalPages: 11 });
    expect(firstPage.items).toHaveLength(10);
  });

  it("allows an administrator to list, create, bulk-update and reset", async () => {
    const employees = createEmployeesRoute({ db: testDb.db });
    expect((await employees.GET(request("/api/admin/employees", adminToken))).status).toBe(200);
    const createResponse = await employees.POST(
      request("/api/admin/employees", adminToken, {
        employeeNo: "TEST-402",
        name: "新增员工",
        email: "employee402@example.invalid",
        workLocation: WorkLocation.XIAN,
        hiredAt: "2026-07-01",
        leftAt: "",
      }),
    );
    expect(createResponse.status).toBe(201);
    expect(JSON.stringify(await createResponse.json())).not.toContain("passwordHash");

    const bulk = createBulkLocationRoute({ db: testDb.db });
    expect(
      (
        await bulk(
          request("/api/admin/employees/bulk-location", adminToken, {
            employeeIds: [targetId],
            location: WorkLocation.SHENZHEN,
          }),
        )
      ).status,
    ).toBe(200);

    const detail = createEmployeeDetailRoute({ db: testDb.db }, targetId);
    expect((await detail.GET(request(`/api/admin/employees/${targetId}`, adminToken))).status).toBe(200);
    const updateResponse = await detail.PATCH(request(`/api/admin/employees/${targetId}`, adminToken, {
      name: "编辑后的员工",
      workLocation: WorkLocation.CHANGSHA,
    }));
    expect(updateResponse.status).toBe(200);
    expect(JSON.stringify(await updateResponse.json())).not.toContain("passwordHash");

    const reset = createResetPasswordRoute({ db: testDb.db }, targetId);
    const resetResponse = await reset(
      request(`/api/admin/employees/${targetId}/reset-password`, adminToken, {}),
    );
    expect(resetResponse.status).toBe(200);
    const resetBody = await resetResponse.json();
    expect(resetBody).toMatchObject({ ok: true, temporaryPassword: expect.stringMatching(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{10}$/) });
    expect(Object.keys(resetBody).sort()).toEqual(["ok", "temporaryPassword"]);
    const resetUser = await testDb.db.user.findUniqueOrThrow({ where: { id: targetId } });
    expect(resetUser.mustChangePassword).toBe(true);
    await expect(verifyPassword(resetBody.temporaryPassword, resetUser.passwordHash)).resolves.toBe(true);
  });

  it("returns 403 to employees for every administrator operation", async () => {
    const employees = createEmployeesRoute({ db: testDb.db });
    const bulk = createBulkLocationRoute({ db: testDb.db });
    const reset = createResetPasswordRoute({ db: testDb.db }, targetId);

    const responses = await Promise.all([
      employees.GET(request("/api/admin/employees", employeeToken)),
      employees.POST(
        request("/api/admin/employees", employeeToken, {
          employeeNo: "DENIED-1",
          name: "拒绝创建",
          email: "denied@example.invalid",
          workLocation: WorkLocation.XIAN,
          hiredAt: "2026-07-01",
        }),
      ),
      bulk(
        request("/api/admin/employees/bulk-location", employeeToken, {
          employeeIds: [targetId],
          location: WorkLocation.XIAN,
        }),
      ),
      reset(
        request(`/api/admin/employees/${targetId}/reset-password`, employeeToken, {}),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
  });

  it("returns 403 from an administrator API until the administrator changes the temporary password", async () => {
    await testDb.db.user.update({
      where: { employeeNo: "ADMIN-ROUTE" },
      data: { mustChangePassword: true },
    });

    const response = await createEmployeesRoute({ db: testDb.db }).GET(
      request("/api/admin/employees", adminToken),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "请先修改初始密码",
    });
  });

  it("enforces employee-only reset scope in the service and re-reads actor and target inside the transaction", async () => {
    const ordinaryAdmin = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "ADMIN-ROUTE" } });
    const superAdmin = await testDb.db.user.create({
      data: {
        employeeNo: "SUPER-RESET",
        name: "超级管理员",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash: await hashPassword("SuperPass123"),
      },
    });
    const employee = await testDb.db.user.findUniqueOrThrow({ where: { id: targetId } });
    const session = await createSession(testDb.db, employee.id);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("employee-unused-token"),
        requestFingerprint: "1".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const firstTemporaryPassword = await resetEmployeePassword(testDb.db, employee.id, ordinaryAdmin.id);
    const secondTemporaryPassword = await resetEmployeePassword(testDb.db, employee.id, superAdmin.id);
    expect(firstTemporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{10}$/);
    expect(secondTemporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{10}$/);
    await expect(resetEmployeePassword(testDb.db, ordinaryAdmin.id, superAdmin.id)).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    await expect(resetEmployeePassword(testDb.db, employee.id, employee.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await testDb.db.session.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(session.token) } })).revokedAt).not.toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow()).usedAt).not.toBeNull();
    const audit = await testDb.db.auditLog.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit)).not.toContain(firstTemporaryPassword);
    expect(JSON.stringify(audit)).not.toContain(secondTemporaryPassword);
  });

  it("redacts the temporary password from denied reset responses", async () => {
    const reset = createResetPasswordRoute({ db: testDb.db }, targetId);
    const response = await reset(
      request(`/api/admin/employees/${targetId}/reset-password`, employeeToken, {}),
    );
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.temporaryPassword).toBeUndefined();
  });
});

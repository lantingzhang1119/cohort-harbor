import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, SessionViewMode, UserSource, UserStatus } from "@/generated/prisma/enums";
import {
  assertOwnResource,
  requireAdmin,
  requireAdminAccess,
  requireEmployee,
  requireEmployeeViewAccess,
  requireSession,
  requireSuperAdmin,
} from "@/features/auth/guards";
import { hashPassword } from "@/features/auth/password";
import { requireEmployeeViewRequest } from "@/features/auth/route-utils";
import { createSession, revokeSession } from "@/features/auth/session";
import { requireSuperAdminRequest } from "@/features/admin-accounts/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { createTestDatabase } from "../helpers/test-db";

describe("authorization guards", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function user(role: Role) {
    const identity = {
      [Role.SUPER_ADMIN]: ["SUPER-ADMIN-001", "测试超级管理员"],
      [Role.ADMIN]: ["ADMIN-001", "测试管理员"],
      [Role.EMPLOYEE]: ["TEST-101", "测试员工"],
    } as const;
    return testDb.db.user.create({
      data: {
        employeeNo: identity[role][0],
        name: identity[role][1],
        role,
        sourceType: UserSource.MANUAL,
        status: UserStatus.ACTIVE,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });
  }

  it("blocks password-change-required sessions from normal authorization", async () => {
    const employee = await user(Role.EMPLOYEE);
    await testDb.db.user.update({
      where: { id: employee.id },
      data: { mustChangePassword: true },
    });
    const created = await createSession(testDb.db, employee.id);

    await expect(requireSession(testDb.db, created.token)).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
      status: 403,
    });
  });

  it("loads only an active, unrevoked session", async () => {
    const employee = await user(Role.EMPLOYEE);
    const created = await createSession(testDb.db, employee.id);

    await expect(requireSession(testDb.db, created.token)).resolves.toMatchObject({
      user: { id: employee.id },
    });

    await revokeSession(testDb.db, created.token);
    await expect(requireSession(testDb.db, created.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("denies an employee access to an administrator handler", async () => {
    const employee = await user(Role.EMPLOYEE);

    expect(() => requireAdmin({ user: employee, viewMode: SessionViewMode.ADMIN })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });

  it("accepts the correct role and scopes employee resources to the session user", async () => {
    const employee = await user(Role.EMPLOYEE);
    expect(requireEmployee({ user: employee }).id).toBe(employee.id);
    expect(() => assertOwnResource({ user: employee }, employee.id)).not.toThrow();
    expect(() => assertOwnResource({ user: employee }, "another-user")).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
    );
  });

  it("authorizes administrator capabilities without exact-role equality", async () => {
    const superAdmin = await user(Role.SUPER_ADMIN);
    const admin = await user(Role.ADMIN);
    const employee = await user(Role.EMPLOYEE);

    expect(() =>
      requireAdminAccess({ user: superAdmin, viewMode: SessionViewMode.ADMIN }),
    ).not.toThrow();
    expect(() =>
      requireAdminAccess({ user: admin, viewMode: SessionViewMode.ADMIN }),
    ).not.toThrow();
    expect(() =>
      requireAdminAccess({ user: admin, viewMode: SessionViewMode.EMPLOYEE }),
    ).toThrowError("无权访问此功能");
    expect(() =>
      requireAdminAccess({ user: employee, viewMode: SessionViewMode.ADMIN }),
    ).toThrowError("无权访问此功能");
    expect(() =>
      requireSuperAdmin({ user: superAdmin, viewMode: SessionViewMode.ADMIN }),
    ).not.toThrow();
    expect(() =>
      requireSuperAdmin({ user: superAdmin, viewMode: SessionViewMode.EMPLOYEE }),
    ).toThrowError("无权访问此功能");
    expect(() =>
      requireSuperAdmin({ user: admin, viewMode: SessionViewMode.ADMIN }),
    ).toThrowError("无权访问此功能");
  });

  it("allows employee pages only while the session is in employee view", async () => {
    const admin = await user(Role.ADMIN);

    expect(() =>
      requireEmployeeViewAccess({ user: admin, viewMode: SessionViewMode.EMPLOYEE }),
    ).not.toThrow();
    expect(() =>
      requireEmployeeViewAccess({ user: admin, viewMode: SessionViewMode.ADMIN }),
    ).toThrowError();
  });

  it("applies view mode in every request-level capability helper", async () => {
    const admin = await user(Role.ADMIN);
    const superAdmin = await user(Role.SUPER_ADMIN);
    const adminMode = await createSession(testDb.db, admin.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    const employeeMode = await createSession(testDb.db, admin.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const superEmployeeMode = await createSession(testDb.db, superAdmin.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const request = (token: string) =>
      new Request("http://localhost:3000/api/test", {
        headers: { cookie: `cohort_harbor_session=${token}` },
      });

    await expect(requireAdminRequest(testDb.db, request(adminMode.token))).resolves.toMatchObject({
      id: admin.id,
    });
    await expect(
      requireAdminRequest(testDb.db, request(employeeMode.token)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requireSuperAdminRequest(testDb.db, request(superEmployeeMode.token)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requireEmployeeViewRequest(testDb.db, request(employeeMode.token)),
    ).resolves.toMatchObject({ user: { id: admin.id } });
    await expect(
      requireEmployeeViewRequest(testDb.db, request(adminMode.token)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

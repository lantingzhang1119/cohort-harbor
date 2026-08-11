import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdministratorDetailRoute } from "@/app/api/admin/administrators/[id]/route";
import { createAdministratorArchiveRoute } from "@/app/api/admin/administrators/[id]/archive/route";
import { createAdministratorPermanentDeleteRoute } from "@/app/api/admin/administrators/[id]/permanent-delete/route";
import { createAdministratorRestoreRoute } from "@/app/api/admin/administrators/[id]/restore/route";
import { createAdministratorTransferRoute } from "@/app/api/admin/administrators/[id]/transfer/route";
import { createAdministratorsRoute } from "@/app/api/admin/administrators/route";
import { Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("administrator account routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let superToken: string;
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass123");
    const superAdmin = await testDb.db.user.create({
      data: {
        employeeNo: "SUPER-ROUTE",
        name: "超级管理员",
        email: "super-route@example.invalid",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
      },
    });
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-ROUTE",
        name: "普通管理员",
        email: "admin-route@example.invalid",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    superToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
  });

  afterEach(async () => testDb.cleanup());

  function request(path: string, token: string, body?: object, origin = "http://localhost:3000") {
    return new Request(`http://localhost:3000${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("lists, creates and fetches only redacted administrator representations", async () => {
    const collection = createAdministratorsRoute({ db: testDb.db });
    const listResponse = await collection.GET(request("/api/admin/administrators", superToken));
    expect(listResponse.status).toBe(200);
    const listText = JSON.stringify(await listResponse.json());
    expect(listText).not.toContain("passwordHash");
    expect(listText).not.toContain("InitialPass123");

    const createResponse = await collection.POST(
      request("/api/admin/administrators", superToken, {
        employeeNo: "ADMIN-CREATED",
        name: "路由创建管理员",
        email: "created-route@example.invalid",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      admin: { id: string };
      temporaryPassword: string;
    };
    expect(created.temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10}$/);
    expect(JSON.stringify(created)).not.toContain("passwordHash");

    const detail = createAdministratorDetailRoute({ db: testDb.db }, created.admin.id);
    const detailResponse = await detail.GET(
      request(`/api/admin/administrators/${created.admin.id}`, superToken),
    );
    expect(detailResponse.status).toBe(200);
    const detailText = JSON.stringify(await detailResponse.json());
    expect(detailText).not.toContain("temporaryPassword");
    expect(detailText).not.toContain("passwordHash");
  });

  it("protects every operation from ordinary administrators", async () => {
    const collection = createAdministratorsRoute({ db: testDb.db });
    const detail = createAdministratorDetailRoute({ db: testDb.db }, adminId);
    const transfer = createAdministratorTransferRoute({ db: testDb.db }, adminId);
    const archive = createAdministratorArchiveRoute({ db: testDb.db }, adminId);
    const restore = createAdministratorRestoreRoute({ db: testDb.db }, adminId);
    const permanentDelete = createAdministratorPermanentDeleteRoute({ db: testDb.db }, adminId);
    const responses = await Promise.all([
      collection.GET(request("/api/admin/administrators", adminToken)),
      collection.POST(request("/api/admin/administrators", adminToken, {
        employeeNo: "DENIED",
        name: "拒绝",
        email: "denied@example.invalid",
      })),
      detail.GET(request(`/api/admin/administrators/${adminId}`, adminToken)),
      transfer(request(`/api/admin/administrators/${adminId}/transfer`, adminToken, {
        employeeNo: "DENIED-TRANSFER",
        name: "拒绝接管",
        email: "denied-transfer@example.invalid",
        temporaryPassword: "DeniedPass123",
        currentPassword: "InitialPass123",
      })),
      archive(request(`/api/admin/administrators/${adminId}/archive`, adminToken, {})),
      restore(request(`/api/admin/administrators/${adminId}/restore`, adminToken, {})),
      permanentDelete(request(`/api/admin/administrators/${adminId}/permanent-delete`, adminToken, {
        currentPassword: "InitialPass123",
        confirmation: "永久删除管理员",
      })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it("performs transfer, archive, restore and permanent deletion without reflecting secrets", async () => {
    const transfer = createAdministratorTransferRoute({ db: testDb.db }, adminId);
    const transferResponse = await transfer(
      request(`/api/admin/administrators/${adminId}/transfer`, superToken, {
        employeeNo: "ADMIN-TRANSFERRED",
        name: "已接管管理员",
        email: "transferred@example.invalid",
        temporaryPassword: "Transfer123",
        currentPassword: "InitialPass123",
      }),
    );
    expect(transferResponse.status).toBe(200);
    const transferText = JSON.stringify(await transferResponse.json());
    expect(transferText).not.toContain("Transfer123");
    expect(transferText).not.toContain("InitialPass123");
    expect(transferText).not.toContain("passwordHash");

    const archive = createAdministratorArchiveRoute({ db: testDb.db }, adminId);
    expect((await archive(request(`/api/admin/administrators/${adminId}/archive`, superToken, {}))).status).toBe(200);
    const restore = createAdministratorRestoreRoute({ db: testDb.db }, adminId);
    expect((await restore(request(`/api/admin/administrators/${adminId}/restore`, superToken, {}))).status).toBe(200);

    const permanentDelete = createAdministratorPermanentDeleteRoute({ db: testDb.db }, adminId);
    const deleteResponse = await permanentDelete(
      request(`/api/admin/administrators/${adminId}/permanent-delete`, superToken, {
        currentPassword: "InitialPass123",
        confirmation: "永久删除管理员",
      }),
    );
    expect(deleteResponse.status).toBe(200);
    expect(JSON.stringify(await deleteResponse.json())).not.toContain("InitialPass123");
    expect(await testDb.db.user.findUnique({ where: { id: adminId } })).toBeNull();
  });

  it("rejects cross-origin mutation requests", async () => {
    const collection = createAdministratorsRoute({ db: testDb.db });
    const response = await collection.POST(
      request(
        "/api/admin/administrators",
        superToken,
        { employeeNo: "CROSS", name: "跨域", email: "cross@example.invalid" },
        "https://attacker.invalid",
      ),
    );
    expect(response.status).toBe(403);
  });
});

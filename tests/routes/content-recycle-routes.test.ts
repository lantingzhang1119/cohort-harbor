import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdminPolicyRecycleBinRoute } from "@/app/api/admin/policies/recycle-bin/route";
import { createAdminPolicySoftDeleteRoute, createAdminPolicyRestoreRoute, createAdminPolicyPermanentDeleteRoute } from "@/app/api/admin/policies/[id]/recycle/route";
import { createAdminPolicyVersionSoftDeleteRoute, createAdminPolicyVersionRestoreRoute, createAdminPolicyVersionPermanentDeleteRoute } from "@/app/api/admin/policies/[id]/versions/[versionId]/recycle/route";
import { createAdminMaterialRecycleBinRoute } from "@/app/api/admin/onboarding-kit/recycle-bin/route";
import { createAdminMaterialSoftDeleteRoute, createAdminMaterialRestoreRoute, createAdminMaterialPermanentDeleteRoute } from "@/app/api/admin/onboarding-kit/[id]/recycle/route";
import { createAdminMaterialVersionSoftDeleteRoute, createAdminMaterialVersionRestoreRoute, createAdminMaterialVersionPermanentDeleteRoute } from "@/app/api/admin/onboarding-kit/[id]/versions/[versionId]/recycle/route";
import { createOnboardingKitRoute } from "@/app/api/onboarding-kit/route";
import { Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createMaterial, publishMaterial, replaceMaterialFile } from "@/features/onboarding-kit/material-service";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { createPolicy, replacePolicyVersion, setPolicyStatus } from "@/features/policies/policy-service";
import { PolicyStatus } from "@/generated/prisma/enums";
import { createTestDatabase } from "../helpers/test-db";

const fictionalPdf = Buffer.from("%PDF-1.7\nroute recycle\n%%EOF");

function upload(name: string, content: string): UploadFileLike {
  const bytes = Buffer.from(content);
  return {
    fileName: name,
    mimeType: "text/plain",
    size: bytes.byteLength,
    stream: () => new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe("content recycle routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let adminToken: string;
  let superToken: string;
  let employeeToken: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-recycle-routes-"));
    const passwordHash = await hashPassword("RoutesPass123");
    const admin = await testDb.db.user.create({
      data: { employeeNo: "R-A", name: "管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash },
    });
    const superAdmin = await testDb.db.user.create({
      data: { employeeNo: "R-SA", name: "超级管理员", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash },
    });
    const employee = await testDb.db.user.create({
      data: { employeeNo: "R-E", name: "员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash },
    });
    adminId = admin.id;
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    superToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const deps = () => ({ db: testDb.db, privateRoot });
  const request = (
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
    origin: string | null = "http://localhost:3000",
  ) => new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      cookie: `cohort_harbor_session=${token}`,
      ...(origin === null ? {} : { origin }),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  it("denies employees and allows admin/super-admin policy version and whole recycle lifecycle", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "路线制度",
      category: "通用",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file: { fileName: "p.pdf", mimeType: "application/pdf", bytes: fictionalPdf },
      actorId: adminId,
      privateRoot,
    });
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, adminId);
    await replacePolicyVersion(testDb.db, policy.id, {
      versionNumber: "2.0",
      effectiveDate: new Date(),
      file: { fileName: "p2.pdf", mimeType: "application/pdf", bytes: fictionalPdf },
      actorId: adminId,
      privateRoot,
    });
    const versions = await testDb.db.policyVersion.findMany({
      where: { policyId: policy.id },
      orderBy: { createdAt: "asc" },
    });
    const v2 = versions[1]!;

    const softVersion = createAdminPolicyVersionSoftDeleteRoute(deps(), policy.id, v2.id);
    expect((await softVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle`, employeeToken, "POST", {}, null))).status).toBe(403);
    expect((await softVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle`, employeeToken, "POST", {}))).status).toBe(403);
    const softOk = await softVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle`, adminToken, "POST", { reason: "错版" }));
    expect(softOk.status).toBe(200);
    expect((await softOk.json()).publishOutcome).toBe("ROLLED_BACK");

    const restoreVersion = createAdminPolicyVersionRestoreRoute(deps(), policy.id, v2.id);
    expect((await restoreVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle/restore`, superToken, "POST", {}))).status).toBe(200);

    await softVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle`, adminToken, "POST", {}));
    const permanentVersion = createAdminPolicyVersionPermanentDeleteRoute(deps(), policy.id, v2.id);
    expect((await permanentVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle/permanent`, adminToken, "POST", {}))).status).toBe(400);
    expect((await permanentVersion(request(`/api/admin/policies/${policy.id}/versions/${v2.id}/recycle/permanent`, adminToken, "POST", { confirmed: true }))).status).toBe(200);

    const softWhole = createAdminPolicySoftDeleteRoute(deps(), policy.id);
    expect((await softWhole(request(`/api/admin/policies/${policy.id}/recycle`, adminToken, "POST", { reason: "整份" }))).status).toBe(200);
    const bin = createAdminPolicyRecycleBinRoute(deps());
    const binResponse = await bin.GET(request("/api/admin/policies/recycle-bin", superToken));
    expect(binResponse.status).toBe(200);
    expect(JSON.stringify(await binResponse.json())).toContain("路线制度");
    expect((await bin.GET(request("/api/admin/policies/recycle-bin", employeeToken))).status).toBe(403);

    const restoreWhole = createAdminPolicyRestoreRoute(deps(), policy.id);
    expect((await restoreWhole(request(`/api/admin/policies/${policy.id}/recycle/restore`, adminToken, "POST", {}))).status).toBe(200);
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe(PolicyStatus.DRAFT);

    await softWhole(request(`/api/admin/policies/${policy.id}/recycle`, adminToken, "POST", {}));
    const permanentWhole = createAdminPolicyPermanentDeleteRoute(deps(), policy.id);
    expect((await permanentWhole(request(`/api/admin/policies/${policy.id}/recycle/permanent`, superToken, "POST", { confirmed: true }))).status).toBe(200);
    expect(await testDb.db.policy.findUnique({ where: { id: policy.id } })).toBeNull();
  });

  it("denies employees and hides soft-deleted materials from employee list after whole delete", async () => {
    const material = await createMaterial(adminId, {
      title: "路线资料",
      category: "测试",
      sortOrder: 0,
    }, upload("m.txt", "m"), { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    await publishMaterial(adminId, material.id, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    await replaceMaterialFile(adminId, material.id, upload("m2.txt", "m2"), { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    const v2 = await testDb.db.onboardingMaterialVersion.findFirstOrThrow({
      where: { materialId: material.id, versionNumber: 2 },
    });

    const softVersion = createAdminMaterialVersionSoftDeleteRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material.id, v2.id);
    expect((await softVersion(request(`/api/admin/onboarding-kit/${material.id}/versions/${v2.id}/recycle`, employeeToken, "POST", {}))).status).toBe(403);
    expect((await softVersion(request(`/api/admin/onboarding-kit/${material.id}/versions/${v2.id}/recycle`, adminToken, "POST", { reason: "错版" }))).status).toBe(200);

    const restoreVersion = createAdminMaterialVersionRestoreRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material.id, v2.id);
    expect((await restoreVersion(request(`/api/admin/onboarding-kit/${material.id}/versions/${v2.id}/recycle/restore`, superToken, "POST", {}))).status).toBe(200);

    const softWhole = createAdminMaterialSoftDeleteRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material.id);
    expect((await softWhole(request(`/api/admin/onboarding-kit/${material.id}/recycle`, adminToken, "POST", {}))).status).toBe(200);

    const employeeList = createOnboardingKitRoute({ db: testDb.db });
    const listResponse = await employeeList.GET(request("/api/onboarding-kit", employeeToken));
    expect(listResponse.status).toBe(200);
    expect(JSON.stringify(await listResponse.json())).not.toContain("路线资料");

    const bin = createAdminMaterialRecycleBinRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    expect((await bin.GET(request("/api/admin/onboarding-kit/recycle-bin", adminToken))).status).toBe(200);

    const restoreWhole = createAdminMaterialRestoreRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material.id);
    expect((await restoreWhole(request(`/api/admin/onboarding-kit/${material.id}/recycle/restore`, adminToken, "POST", {}))).status).toBe(200);

    await softWhole(request(`/api/admin/onboarding-kit/${material.id}/recycle`, adminToken, "POST", {}));
    const permanent = createAdminMaterialPermanentDeleteRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material.id);
    expect((await permanent(request(`/api/admin/onboarding-kit/${material.id}/recycle/permanent`, adminToken, "POST", { confirmed: true }))).status).toBe(200);
    expect(await testDb.db.onboardingMaterial.findUnique({ where: { id: material.id } })).toBeNull();

    // permanent version path smoke
    const material2 = await createMaterial(adminId, {
      title: "版本永久",
      category: "测试",
      sortOrder: 0,
    }, upload("p.txt", "p"), { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    await replaceMaterialFile(adminId, material2.id, upload("p2.txt", "p2"), { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    const version = await testDb.db.onboardingMaterialVersion.findFirstOrThrow({
      where: { materialId: material2.id, versionNumber: 1 },
    });
    await createAdminMaterialVersionSoftDeleteRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material2.id, version.id)(
      request(`/api/admin/onboarding-kit/${material2.id}/versions/${version.id}/recycle`, adminToken, "POST", {}),
    );
    expect((await createAdminMaterialVersionPermanentDeleteRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, material2.id, version.id)(
      request(`/api/admin/onboarding-kit/${material2.id}/versions/${version.id}/recycle/permanent`, adminToken, "POST", { confirmed: true }),
    )).status).toBe(200);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { City, PolicyPreviewStatus, PolicyStatus, Role, UserSource, UserStatus, WorkLocation } from "@/generated/prisma/enums";
import {
  createPolicy,
  listPoliciesForEmployee,
  PolicyFileError,
  replacePolicyVersion,
  setPolicySortOrder,
  setPolicyStatus,
} from "@/features/policies/policy-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

const fictionalPdf = Buffer.from("%PDF-1.7\nfictional policy\n%%EOF");

describe("policy service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-policy-"));
    const passwordHash = await hashPassword("InitialPass!23");
    adminId = (await testDb.db.user.create({ data: { employeeNo: "ADMIN-POLICY", name: "制度管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })).id;
    employeeId = (await testDb.db.user.create({ data: { employeeNo: "TEST-POLICY", name: "上海员工", workLocation: WorkLocation.SHANGHAI, sourceType: UserSource.MANUAL, passwordHash } })).id;
  });
  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const file = {
    fileName: "员工制度.pdf",
    mimeType: "application/pdf",
    bytes: fictionalPdf,
  };

  it("creates, versions, publishes and archives a valid policy", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "员工行为规范",
      category: "通用制度",
      applicableCities: [City.SHANGHAI, City.SHENZHEN],
      versionNumber: "1.0",
      effectiveDate: new Date("2026-07-01T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });
    expect(policy.status).toBe(PolicyStatus.DRAFT);
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, adminId);
    await replacePolicyVersion(testDb.db, policy.id, {
      versionNumber: "1.1",
      effectiveDate: new Date("2026-07-15T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });
    expect(await testDb.db.policyVersion.count({ where: { policyId: policy.id } })).toBe(2);
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.ARCHIVED, adminId);
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe(PolicyStatus.ARCHIVED);
  });

  it.each([
    { label: "extension", fileName: "policy.txt", mimeType: "application/pdf", bytes: fictionalPdf },
    { label: "MIME", fileName: "policy.pdf", mimeType: "text/plain", bytes: fictionalPdf },
    { label: "signature", fileName: "policy.pdf", mimeType: "application/pdf", bytes: Buffer.from("not-pdf") },
    { label: "size", fileName: "policy.pdf", mimeType: "application/pdf", bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(1024)]) },
  ])("rejects invalid PDF $label", async (invalidFile) => {
    await expect(
      createPolicy(testDb.db, {
        name: "无效制度",
        category: "测试",
        applicableCities: [City.SHANGHAI],
        versionNumber: "1.0",
        effectiveDate: new Date(),
        file: invalidFile,
        actorId: adminId,
        privateRoot,
        maxBytes: invalidFile.label === "size" ? 100 : undefined,
      }),
    ).rejects.toBeInstanceOf(PolicyFileError);
  });

  it("shows every published policy to active employees regardless of legacy city scope", async () => {
    const shanghai = await createPolicy(testDb.db, { name: "上海制度", category: "属地", applicableCities: [City.SHANGHAI], versionNumber: "1.0", effectiveDate: new Date(), file, actorId: adminId, privateRoot });
    const xian = await createPolicy(testDb.db, { name: "西安制度", category: "属地", applicableCities: [City.XIAN], versionNumber: "1.0", effectiveDate: new Date(), file, actorId: adminId, privateRoot });
    await setPolicyStatus(testDb.db, shanghai.id, PolicyStatus.PUBLISHED, adminId);
    await setPolicyStatus(testDb.db, xian.id, PolicyStatus.PUBLISHED, adminId);

    const policies = await listPoliciesForEmployee(testDb.db, employeeId);
    expect(policies.map((policy) => policy.name).sort()).toEqual(["上海制度", "西安制度"]);
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: shanghai.id } })).applicableCities).toEqual([]);

    const passwordHash = await hashPassword("InitialPass!23");
    const newcomer = await testDb.db.user.create({ data: { employeeNo: "NEW-POLICY", name: "新员工", workLocation: WorkLocation.XIAN, sourceType: UserSource.MANUAL, passwordHash } });
    expect((await listPoliciesForEmployee(testDb.db, newcomer.id)).map((policy) => policy.name).sort()).toEqual(["上海制度", "西安制度"]);

    const disabled = await testDb.db.user.create({ data: { employeeNo: "OFF-POLICY", name: "停用员工", enabled: false, sourceType: UserSource.MANUAL, passwordHash } });
    const departed = await testDb.db.user.create({ data: { employeeNo: "LEFT-POLICY", name: "离职员工", status: UserStatus.DEPARTED, sourceType: UserSource.MANUAL, passwordHash } });
    expect(await listPoliciesForEmployee(testDb.db, disabled.id)).toEqual([]);
    expect(await listPoliciesForEmployee(testDb.db, departed.id)).toEqual([]);
  });

  it("prevents publishing when the newest active version has no ready preview", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "待预览制度",
      category: "测试",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file,
      actorId: adminId,
      privateRoot,
    });
    const newest = await testDb.db.policyVersion.findFirstOrThrow({ where: { policyId: policy.id } });
    await testDb.db.policyVersion.update({ where: { id: newest.id }, data: { previewStatus: PolicyPreviewStatus.FAILED, previewError: "转换失败" } });
    await expect(setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, adminId)).rejects.toThrow("预览");
  });

  it("updates policy display order and records an audit event", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "排序制度",
      category: "通用制度",
      applicableCities: [City.SHANGHAI],
      versionNumber: "1.0",
      effectiveDate: new Date("2026-07-01T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });

    await setPolicySortOrder(testDb.db, policy.id, 25, adminId);

    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } })).sortOrder).toBe(25);
    expect(await testDb.db.auditLog.findFirst({
      where: { action: "POLICY_SORT_CHANGE", targetId: policy.id },
    })).not.toBeNull();
  });
});

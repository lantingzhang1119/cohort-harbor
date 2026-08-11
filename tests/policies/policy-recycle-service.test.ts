import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PolicyStatus,
  Role,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  createPolicy,
  listPoliciesForEmployee,
  replacePolicyVersion,
  setPolicyStatus,
} from "@/features/policies/policy-service";
import {
  listPolicyRecycleBin,
  permanentlyDeletePolicy,
  permanentlyDeletePolicyVersion,
  purgeExpiredPolicyRecycleBin,
  restorePolicy,
  restorePolicyVersion,
  softDeletePolicy,
  softDeletePolicyVersion,
} from "@/features/policies/policy-recycle-service";
import { resolvePrivateAssetPath } from "@/lib/storage/private-storage";
import { createTestDatabase } from "../helpers/test-db";

const fictionalPdf = Buffer.from("%PDF-1.7\nfictional policy recycle\n%%EOF");

describe("policy recycle service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let superAdminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-policy-recycle-"));
    const passwordHash = await hashPassword("InitialPass!23");
    adminId = (await testDb.db.user.create({
      data: { employeeNo: "ADMIN-RECYCLE", name: "制度回收管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash },
    })).id;
    superAdminId = (await testDb.db.user.create({
      data: { employeeNo: "SUPER-RECYCLE", name: "制度回收超管", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, passwordHash },
    })).id;
    employeeId = (await testDb.db.user.create({
      data: {
        employeeNo: "EMP-RECYCLE",
        name: "制度回收员工",
        role: Role.EMPLOYEE,
        workLocation: WorkLocation.SHANGHAI,
        status: UserStatus.ACTIVE,
        sourceType: UserSource.MANUAL,
        passwordHash,
      },
    })).id;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const file = {
    fileName: "制度.pdf",
    mimeType: "application/pdf",
    bytes: fictionalPdf,
  };

  async function createPublishedWithVersions() {
    const policy = await createPolicy(testDb.db, {
      name: "考勤制度",
      category: "通用",
      versionNumber: "1.0",
      effectiveDate: new Date("2026-01-01T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, adminId);
    await replacePolicyVersion(testDb.db, policy.id, {
      versionNumber: "2.0",
      effectiveDate: new Date("2026-02-01T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });
    const versions = await testDb.db.policyVersion.findMany({
      where: { policyId: policy.id },
      orderBy: { createdAt: "asc" },
      include: { fileAsset: true, previewAsset: true },
    });
    return { policy, v1: versions[0]!, v2: versions[1]! };
  }

  it("rejects employee soft-delete while allowing admin and super-admin equally", async () => {
    const { policy, v2 } = await createPublishedWithVersions();
    await expect(softDeletePolicyVersion(testDb.db, {
      actorId: employeeId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(softDeletePolicy(testDb.db, {
      actorId: employeeId,
      policyId: policy.id,
      privateRoot,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const versionResult = await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      reason: "上传错版本",
      privateRoot,
    });
    expect(versionResult.publishOutcome).toBe("ROLLED_BACK");
    expect(versionResult.rolledBackToVersionNumber).toBe("1.0");

    const whole = await createPolicy(testDb.db, {
      name: "超管删除整份",
      category: "通用",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file,
      actorId: superAdminId,
      privateRoot,
    });
    await softDeletePolicy(testDb.db, {
      actorId: superAdminId,
      policyId: whole.id,
      reason: "整份废弃",
      privateRoot,
    });
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: whole.id } })).deletedAt).not.toBeNull();
  });

  it("soft-deletes a non-current draft version without affecting published status", async () => {
    const { policy, v1, v2 } = await createPublishedWithVersions();
    const draft = await replacePolicyVersion(testDb.db, policy.id, {
      versionNumber: "2.1-draft",
      effectiveDate: new Date("2026-03-01T00:00:00.000Z"),
      file,
      actorId: adminId,
      privateRoot,
    });
    // Make v2 the "current" published ready version by soft-deleting draft later;
    // first delete draft (newest) — publish outcome should keep published if older READY exists.
    // After draft is newest, soft-deleting draft rolls back to v2 which remains published.
    const result = await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: draft.id,
      privateRoot,
    });
    expect(result.publishOutcome).toBe("ROLLED_BACK");
    const stored = await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored.status).toBe(PolicyStatus.PUBLISHED);
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: draft.id } })).deletedAt).not.toBeNull();
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).toBeNull();
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).toBeNull();
    const visible = await listPoliciesForEmployee(testDb.db, employeeId);
    expect(visible.some((item) => item.id === policy.id)).toBe(true);
  });

  it("rolls back to previous available version when current published version is soft-deleted", async () => {
    const { policy, v1, v2 } = await createPublishedWithVersions();
    const result = await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
    });
    expect(result).toMatchObject({
      publishOutcome: "ROLLED_BACK",
      rolledBackToVersionNumber: "1.0",
    });
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe(PolicyStatus.PUBLISHED);
    const visible = await listPoliciesForEmployee(testDb.db, employeeId);
    const item = visible.find((policyItem) => policyItem.id === policy.id);
    expect(item?.versions[0]?.id).toBe(v1.id);
    expect(await testDb.db.auditLog.findFirst({
      where: { action: "POLICY_VERSION_SOFT_DELETE", targetId: policy.id },
    })).toMatchObject({
      metadata: expect.objectContaining({
        versionId: v2.id,
        scope: "VERSION",
        publishOutcome: "ROLLED_BACK",
      }),
    });
  });

  it("unpublishes when the last available version is soft-deleted", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "单版本制度",
      category: "通用",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file,
      actorId: adminId,
      privateRoot,
    });
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, adminId);
    const version = await testDb.db.policyVersion.findFirstOrThrow({ where: { policyId: policy.id } });
    const result = await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: version.id,
      privateRoot,
    });
    expect(result.publishOutcome).toBe("UNPUBLISHED");
    expect((await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe(PolicyStatus.ARCHIVED);
    expect(await listPoliciesForEmployee(testDb.db, employeeId)).toEqual([]);
  });

  it("soft-deletes whole policy, hides from employees, restores as unpublished draft", async () => {
    const { policy, v1, v2 } = await createPublishedWithVersions();
    await softDeletePolicy(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      reason: "整份下线",
      privateRoot,
    });

    const deleted = await testDb.db.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.statusBeforeDelete).toBe(PolicyStatus.PUBLISHED);
    expect(deleted.status).toBe(PolicyStatus.ARCHIVED);
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).not.toBeNull();
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).not.toBeNull();
    expect(await listPoliciesForEmployee(testDb.db, employeeId)).toEqual([]);

    const bin = await listPolicyRecycleBin(testDb.db, adminId);
    expect(bin.policies.some((item) => item.id === policy.id)).toBe(true);

    const restored = await restorePolicy(testDb.db, {
      actorId: superAdminId,
      policyId: policy.id,
      privateRoot,
    });
    expect(restored.status).toBe(PolicyStatus.DRAFT);
    expect(restored.deletedAt).toBeNull();
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).toBeNull();
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).toBeNull();
    expect(await listPoliciesForEmployee(testDb.db, employeeId)).toEqual([]);
    expect(await testDb.db.auditLog.findFirst({
      where: { action: "POLICY_RESTORE", targetId: policy.id },
    })).not.toBeNull();
  });

  it("restores a soft-deleted version and permanently deletes storage on permanent delete", async () => {
    const { policy, v1, v2 } = await createPublishedWithVersions();
    const originalKey = v2.fileAsset.storageKey;
    const previewKey = v2.previewAsset?.storageKey;
    expect(previewKey).toBeTruthy();
    const originalPath = resolvePrivateAssetPath(originalKey, privateRoot)!;
    const previewPath = resolvePrivateAssetPath(previewKey!, privateRoot)!;
    await access(originalPath);
    await access(previewPath);

    await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
    });
    await restorePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
    });
    expect((await testDb.db.policyVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).toBeNull();

    await softDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
    });
    await permanentlyDeletePolicyVersion(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      versionId: v2.id,
      privateRoot,
      confirmed: true,
    });
    expect(await testDb.db.policyVersion.findUnique({ where: { id: v2.id } })).toBeNull();
    expect(await testDb.db.fileAsset.findUnique({ where: { id: v2.fileAssetId } })).toBeNull();
    await expect(access(originalPath)).rejects.toThrow();
    await expect(access(previewPath)).rejects.toThrow();
    expect(await testDb.db.policyVersion.findUnique({ where: { id: v1.id } })).not.toBeNull();
  });

  it("permanently deletes whole recycled policy with files and purges expired items idempotently", async () => {
    const { policy, v1, v2 } = await createPublishedWithVersions();
    const keys = [v1.fileAsset.storageKey, v1.previewAsset?.storageKey, v2.fileAsset.storageKey, v2.previewAsset?.storageKey].filter(Boolean) as string[];
    const paths = keys.map((key) => resolvePrivateAssetPath(key, privateRoot)!);
    for (const filePath of paths) await access(filePath);

    await softDeletePolicy(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      privateRoot,
    });
    await permanentlyDeletePolicy(testDb.db, {
      actorId: adminId,
      policyId: policy.id,
      privateRoot,
      confirmed: true,
    });
    expect(await testDb.db.policy.findUnique({ where: { id: policy.id } })).toBeNull();
    for (const filePath of paths) await expect(access(filePath)).rejects.toThrow();

    const aged = await createPolicy(testDb.db, {
      name: "过期回收制度",
      category: "通用",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file,
      actorId: adminId,
      privateRoot,
    });
    await softDeletePolicy(testDb.db, {
      actorId: adminId,
      policyId: aged.id,
      privateRoot,
    });
    const agedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await testDb.db.policy.update({ where: { id: aged.id }, data: { deletedAt: agedAt } });
    await testDb.db.policyVersion.updateMany({ where: { policyId: aged.id }, data: { deletedAt: agedAt } });

    // Retention cleanup is a system operation. It must neither depend on a
    // surviving administrator nor impersonate one in the audit trail.
    await testDb.db.user.updateMany({
      where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN] } },
      data: { role: Role.EMPLOYEE },
    });

    const first = await purgeExpiredPolicyRecycleBin(testDb.db, { privateRoot, now: new Date() });
    const second = await purgeExpiredPolicyRecycleBin(testDb.db, { privateRoot, now: new Date() });
    expect(first.purgedPolicies).toBe(1);
    expect(second.purgedPolicies).toBe(0);
    expect(await testDb.db.policy.findUnique({ where: { id: aged.id } })).toBeNull();
    expect(await testDb.db.auditLog.findFirstOrThrow({
      where: { action: "POLICY_PERMANENT_DELETE", targetId: aged.id },
    })).toMatchObject({ actorId: null, actorSnapshot: null });
  });
});

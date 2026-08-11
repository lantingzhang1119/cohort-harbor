import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OnboardingMaterialStatus,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import {
  createMaterial,
  publishMaterial,
  replaceMaterialFile,
} from "@/features/onboarding-kit/material-service";
import {
  listMaterialRecycleBin,
  permanentlyDeleteMaterial,
  permanentlyDeleteMaterialVersion,
  purgeExpiredMaterialRecycleBin,
  restoreMaterial,
  restoreMaterialVersion,
  softDeleteMaterial,
  softDeleteMaterialVersion,
} from "@/features/onboarding-kit/material-recycle-service";
import { resolvePrivateAssetPath } from "@/lib/storage/private-storage";
import { createTestDatabase } from "../helpers/test-db";

function textUpload(name: string, content: string): UploadFileLike {
  const bytes = Buffer.from(content, "utf8");
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

describe("onboarding material recycle service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let superAdminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-material-recycle-"));
    const passwordHash = await hashPassword("InitialPass123");
    [adminId, superAdminId, employeeId] = await Promise.all([
      testDb.db.user.create({ data: { employeeNo: "MAT-R-ADMIN", name: "资料回收管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
      testDb.db.user.create({ data: { employeeNo: "MAT-R-SUPER", name: "资料回收超管", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
      testDb.db.user.create({ data: { employeeNo: "MAT-R-EMP", name: "资料回收员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const options = () => ({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });

  async function createPublishedWithTwoVersions() {
    const material = await createMaterial(adminId, {
      title: "入职手册",
      category: "入职必读",
      sortOrder: 0,
    }, textUpload("v1.txt", "one"), options());
    await publishMaterial(adminId, material.id, options());
    await replaceMaterialFile(adminId, material.id, textUpload("v2.txt", "two"), options());
    const versions = await testDb.db.onboardingMaterialVersion.findMany({
      where: { materialId: material.id },
      orderBy: { versionNumber: "asc" },
      include: { fileAsset: true },
    });
    return { material, v1: versions[0]!, v2: versions[1]! };
  }

  it("rejects employee soft-delete while allowing admin and super-admin equally", async () => {
    const { material, v2 } = await createPublishedWithTwoVersions();
    await expect(softDeleteMaterialVersion(employeeId, material.id, v2.id, options())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(softDeleteMaterial(employeeId, material.id, options())).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rolled = await softDeleteMaterialVersion(adminId, material.id, v2.id, options(), { reason: "错传" });
    expect(rolled.publishOutcome).toBe("ROLLED_BACK");
    expect(rolled.rolledBackToVersionNumber).toBe(1);

    const another = await createMaterial(superAdminId, {
      title: "超管整份",
      category: "测试",
      sortOrder: 1,
    }, textUpload("a.txt", "a"), options());
    await softDeleteMaterial(superAdminId, another.id, options(), { reason: "废弃" });
    expect((await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: another.id } })).deletedAt).not.toBeNull();
  });

  it("soft-deletes a non-current version without changing current published pointer", async () => {
    const { material, v1, v2 } = await createPublishedWithTwoVersions();
    const result = await softDeleteMaterialVersion(adminId, material.id, v1.id, options());
    expect(result.publishOutcome).toBe("UNCHANGED");
    const stored = await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } });
    expect(stored.status).toBe(OnboardingMaterialStatus.PUBLISHED);
    expect(stored.currentVersionId).toBe(v2.id);
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).not.toBeNull();
  });

  it("rolls back currentVersion when current published version is soft-deleted", async () => {
    const { material, v1, v2 } = await createPublishedWithTwoVersions();
    const result = await softDeleteMaterialVersion(adminId, material.id, v2.id, options());
    expect(result).toMatchObject({ publishOutcome: "ROLLED_BACK", rolledBackToVersionNumber: 1 });
    const stored = await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } });
    expect(stored.status).toBe(OnboardingMaterialStatus.PUBLISHED);
    expect(stored.currentVersionId).toBe(v1.id);
    expect(await testDb.db.auditLog.findFirst({
      where: { action: "ONBOARDING_MATERIAL_VERSION_SOFT_DELETE", targetId: material.id },
    })).toMatchObject({
      metadata: expect.objectContaining({ versionId: v2.id, scope: "VERSION", publishOutcome: "ROLLED_BACK" }),
    });
  });

  it("unpublishes when the last available version is soft-deleted", async () => {
    const material = await createMaterial(adminId, {
      title: "单版本资料",
      category: "测试",
      sortOrder: 0,
    }, textUpload("only.txt", "only"), options());
    await publishMaterial(adminId, material.id, options());
    const version = await testDb.db.onboardingMaterialVersion.findFirstOrThrow({ where: { materialId: material.id } });
    const result = await softDeleteMaterialVersion(adminId, material.id, version.id, options());
    expect(result.publishOutcome).toBe("UNPUBLISHED");
    const stored = await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } });
    expect(stored.status).toBe(OnboardingMaterialStatus.ARCHIVED);
    expect(stored.currentVersionId).toBeNull();
  });

  it("soft-deletes whole material, lists recycle bin, restores as draft unpublished", async () => {
    const { material, v1, v2 } = await createPublishedWithTwoVersions();
    await softDeleteMaterial(adminId, material.id, options(), { reason: "整包下线" });
    const deleted = await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.statusBeforeDelete).toBe(OnboardingMaterialStatus.PUBLISHED);
    expect(deleted.status).toBe(OnboardingMaterialStatus.ARCHIVED);
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).not.toBeNull();
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).not.toBeNull();

    const bin = await listMaterialRecycleBin(adminId, options());
    expect(bin.materials.some((item) => item.id === material.id)).toBe(true);

    const restored = await restoreMaterial(superAdminId, material.id, options());
    expect(restored.status).toBe(OnboardingMaterialStatus.DRAFT);
    expect(restored.deletedAt).toBeNull();
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v1.id } })).deletedAt).toBeNull();
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).toBeNull();
    // current version pointer restored to latest non-deleted
    expect(restored.currentVersionId).toBe(v2.id);
    expect(await testDb.db.auditLog.findFirst({
      where: { action: "ONBOARDING_MATERIAL_RESTORE", targetId: material.id },
    })).not.toBeNull();
  });

  it("permanently deletes version files and purges expired whole materials idempotently", async () => {
    const { material, v1, v2 } = await createPublishedWithTwoVersions();
    const v2Path = resolvePrivateAssetPath(v2.fileAsset.storageKey, privateRoot)!;
    await access(v2Path);

    await softDeleteMaterialVersion(adminId, material.id, v2.id, options());
    await restoreMaterialVersion(adminId, material.id, v2.id, options());
    expect((await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: v2.id } })).deletedAt).toBeNull();

    await softDeleteMaterialVersion(adminId, material.id, v2.id, options());
    await permanentlyDeleteMaterialVersion(adminId, material.id, v2.id, { ...options(), confirmed: true });
    expect(await testDb.db.onboardingMaterialVersion.findUnique({ where: { id: v2.id } })).toBeNull();
    expect(await testDb.db.fileAsset.findUnique({ where: { id: v2.fileAssetId } })).toBeNull();
    await expect(access(v2Path)).rejects.toThrow();
    expect(await testDb.db.onboardingMaterialVersion.findUnique({ where: { id: v1.id } })).not.toBeNull();

    await softDeleteMaterial(adminId, material.id, options());
    const v1Path = resolvePrivateAssetPath(v1.fileAsset.storageKey, privateRoot)!;
    await permanentlyDeleteMaterial(adminId, material.id, { ...options(), confirmed: true });
    expect(await testDb.db.onboardingMaterial.findUnique({ where: { id: material.id } })).toBeNull();
    await expect(access(v1Path)).rejects.toThrow();

    const aged = await createMaterial(adminId, {
      title: "过期资料",
      category: "测试",
      sortOrder: 0,
    }, textUpload("old.txt", "old"), options());
    await softDeleteMaterial(adminId, aged.id, options());
    const agedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await testDb.db.onboardingMaterial.update({ where: { id: aged.id }, data: { deletedAt: agedAt } });
    await testDb.db.onboardingMaterialVersion.updateMany({ where: { materialId: aged.id }, data: { deletedAt: agedAt } });

    // Scheduled retention cleanup must be attributable to the system, not to
    // whichever administrator happens to sort first in the database.
    await testDb.db.user.updateMany({
      where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN] } },
      data: { role: Role.EMPLOYEE },
    });

    const first = await purgeExpiredMaterialRecycleBin(options(), { now: new Date() });
    const second = await purgeExpiredMaterialRecycleBin(options(), { now: new Date() });
    expect(first.purgedMaterials).toBe(1);
    expect(second.purgedMaterials).toBe(0);
    expect(await testDb.db.onboardingMaterial.findUnique({ where: { id: aged.id } })).toBeNull();
    expect(await testDb.db.auditLog.findFirstOrThrow({
      where: { action: "ONBOARDING_MATERIAL_PERMANENT_DELETE", targetId: aged.id },
    })).toMatchObject({ actorId: null, actorSnapshot: null });
    // storage directory may retain empty folders; ensure no leftover .txt files for purged item
    const files = await readdir(privateRoot, { recursive: true });
    expect(files.filter((entry) => String(entry).endsWith(".txt"))).toHaveLength(0);
  });
});

import { readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileAssetKind,
  OnboardingMaterialStatus,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import {
  archiveMaterial,
  createMaterial,
  publishMaterial,
  replaceMaterialFile,
  updateMaterial,
} from "@/features/onboarding-kit/material-service";
import { createTestDatabase } from "../helpers/test-db";

function textUpload(name: string, content: string): UploadFileLike {
  const bytes = Buffer.from(content, "utf8");
  return {
    fileName: name,
    mimeType: "text/plain",
    size: bytes.byteLength,
    stream: () => new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }),
  };
}

describe("versioned onboarding material service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let superAdminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-materials-"));
    const passwordHash = await hashPassword("InitialPass123");
    [adminId, superAdminId, employeeId] = await Promise.all([
      testDb.db.user.create({ data: { employeeNo: "MATERIAL-ADMIN", name: "资料管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
      testDb.db.user.create({ data: { employeeNo: "MATERIAL-SUPER", name: "资料超级管理员", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
      testDb.db.user.create({ data: { employeeNo: "MATERIAL-EMP", name: "资料员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash } }).then((user) => user.id),
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const options = () => ({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });

  it.each(["admin", "super"])("gives %s the same create permission and writes immutable version one", async (seat) => {
    const actorId = seat === "admin" ? adminId : superAdminId;
    const material = await createMaterial(actorId, {
      title: `${seat} 入职手册`,
      category: "入职必读",
      description: "第一天使用",
      sortOrder: 3,
    }, textUpload("入职说明.txt", "欢迎加入CohortHarbor"), options());

    expect(material).toMatchObject({
      title: `${seat} 入职手册`,
      status: OnboardingMaterialStatus.DRAFT,
      currentVersion: { versionNumber: 1, originalName: "入职说明.txt" },
    });
    const stored = await testDb.db.onboardingMaterial.findUniqueOrThrow({
      where: { id: material.id },
      include: { currentVersion: { include: { fileAsset: true } } },
    });
    expect(stored.currentVersion?.fileAsset.kind).toBe(FileAssetKind.ONBOARDING_MATERIAL);
    expect(stored.currentVersionId).toBe(stored.currentVersion?.id);
    expect(await testDb.db.auditLog.count({ where: { action: "ONBOARDING_MATERIAL_CREATE" } })).toBe(1);
  });

  it("rejects employee creation and removes a staged file if the database transaction fails", async () => {
    await expect(createMaterial(employeeId, {
      title: "越权资料",
      category: "测试",
      sortOrder: 0,
    }, textUpload("denied.txt", "denied"), options())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const files = await readdir(privateRoot, { recursive: true }).catch(() => []);
    expect(files.filter((entry) => String(entry).endsWith(".txt"))).toHaveLength(0);
    expect(await testDb.db.onboardingMaterial.count()).toBe(0);
  });

  it("replaces with new immutable versions, updates metadata separately and preserves old bytes", async () => {
    const material = await createMaterial(adminId, {
      title: "入职手册",
      category: "入职必读",
      sortOrder: 0,
    }, textUpload("v1.txt", "version-one"), options());
    const oldVersion = await testDb.db.onboardingMaterialVersion.findFirstOrThrow({
      where: { materialId: material.id, versionNumber: 1 },
      include: { fileAsset: true },
    });

    await replaceMaterialFile(superAdminId, material.id, textUpload("v2.txt", "version-two"), options());
    await updateMaterial(adminId, material.id, {
      title: "更新后的入职手册",
      category: "工具资料",
      description: "只改元数据",
      sortOrder: 8,
    }, options());

    const stored = await testDb.db.onboardingMaterial.findUniqueOrThrow({
      where: { id: material.id },
      include: { versions: { orderBy: { versionNumber: "asc" }, include: { fileAsset: true } }, currentVersion: true },
    });
    expect(stored.versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(stored.currentVersion?.versionNumber).toBe(2);
    expect(stored.versions[0]).toMatchObject({
      id: oldVersion.id,
      fileAssetId: oldVersion.fileAssetId,
      originalName: "v1.txt",
    });
    expect(stored).toMatchObject({ title: "更新后的入职手册", category: "工具资料", sortOrder: 8 });
  });

  it("serializes concurrent replacements into unique increasing versions", async () => {
    const material = await createMaterial(adminId, {
      title: "并发资料",
      category: "测试",
      sortOrder: 0,
    }, textUpload("v1.txt", "one"), options());

    await Promise.all([
      replaceMaterialFile(adminId, material.id, textUpload("v2-a.txt", "two-a"), options()),
      replaceMaterialFile(superAdminId, material.id, textUpload("v2-b.txt", "two-b"), options()),
    ]);

    const versions = await testDb.db.onboardingMaterialVersion.findMany({
      where: { materialId: material.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
    expect(new Set(versions.map((version) => version.fileAssetId)).size).toBe(3);
  });

  it("publishes and archives atomically with actor snapshots and audit history", async () => {
    const material = await createMaterial(adminId, {
      title: "生命周期资料",
      category: "测试",
      sortOrder: 0,
    }, textUpload("life.txt", "life"), options());

    await publishMaterial(superAdminId, material.id, options());
    expect(await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } }))
      .toMatchObject({ status: OnboardingMaterialStatus.PUBLISHED, updatedById: superAdminId });
    await archiveMaterial(adminId, material.id, options());
    expect(await testDb.db.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id } }))
      .toMatchObject({ status: OnboardingMaterialStatus.ARCHIVED, updatedById: adminId });
    const actions = await testDb.db.auditLog.findMany({
      where: { targetId: material.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map(({ action }) => action)).toEqual([
      "ONBOARDING_MATERIAL_CREATE",
      "ONBOARDING_MATERIAL_PUBLISH",
      "ONBOARDING_MATERIAL_ARCHIVE",
    ]);
  });
});

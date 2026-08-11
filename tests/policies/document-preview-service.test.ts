import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileAssetKind, PolicyPreviewStatus, Role, UserSource } from "@/generated/prisma/enums";
import { createPolicy } from "@/features/policies/policy-service";
import { prepareOfficeConversionRuntime } from "@/features/policies/document-preview-service";
import { hashPassword } from "@/features/auth/password";
import { resolvePrivateAssetPath } from "@/lib/storage/private-storage";
import { createTestDatabase } from "../helpers/test-db";

describe("document preview service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "policy-preview-"));
    const passwordHash = await hashPassword("InitialPass!23");
    adminId = (await testDb.db.user.create({ data: { employeeNo: "ADMIN-PREVIEW", name: "预览管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })).id;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  it("keeps original and PDF preview as separate private assets", async () => {
    const bytes = new Uint8Array(Buffer.from("%PDF-1.7\nfixture\n%%EOF"));
    const policy = await createPolicy(testDb.db, {
      name: "PDF 制度",
      category: "测试",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file: { fileName: "制度.pdf", mimeType: "application/pdf", bytes },
      actorId: adminId,
      privateRoot,
    });
    const version = await testDb.db.policyVersion.findFirstOrThrow({
      where: { policyId: policy.id },
      include: { fileAsset: true, previewAsset: true },
    });
    expect(version.previewStatus).toBe(PolicyPreviewStatus.READY);
    expect(version.previewFormat).toBe("PDF");
    expect(version.fileAsset.kind).toBe(FileAssetKind.POLICY_FILE);
    expect(version.previewAsset?.kind).toBe(FileAssetKind.POLICY_PREVIEW);
    expect(version.previewAssetId).not.toBe(version.fileAssetId);
    const previewPath = resolvePrivateAssetPath(version.previewAsset!.storageKey, privateRoot)!;
    expect(new Uint8Array(await readFile(previewPath))).toEqual(bytes);
  });

  it("normalizes GB18030 text into a UTF-8 private preview", async () => {
    const gb18030 = new Uint8Array([0xd6, 0xc6, 0xb6, 0xc8, 0x0d, 0x0a, 0xb5, 0xda, 0xd2, 0xbb, 0xcc, 0xf5]);
    const policy = await createPolicy(testDb.db, {
      name: "文本制度",
      category: "测试",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file: { fileName: "制度.txt", mimeType: "text/plain", bytes: gb18030 },
      actorId: adminId,
      privateRoot,
    });
    const version = await testDb.db.policyVersion.findFirstOrThrow({ where: { policyId: policy.id }, include: { previewAsset: true } });
    expect(version.previewStatus).toBe(PolicyPreviewStatus.READY);
    expect(version.previewFormat).toBe("TEXT");
    const previewPath = resolvePrivateAssetPath(version.previewAsset!.storageKey, privateRoot)!;
    expect(await readFile(previewPath, "utf8")).toBe("制度\n第一条");
  });

  it("records an honest failed state when an Office converter cannot produce a preview", async () => {
    const policy = await createPolicy(testDb.db, {
      name: "Office 制度",
      category: "测试",
      versionNumber: "1.0",
      effectiveDate: new Date(),
      file: {
        fileName: "制度.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      },
      actorId: adminId,
      privateRoot,
      previewOptions: { officeConverter: async () => { throw new Error("soffice unavailable"); } },
    });
    const version = await testDb.db.policyVersion.findFirstOrThrow({ where: { policyId: policy.id } });
    expect(version.previewStatus).toBe(PolicyPreviewStatus.FAILED);
    expect(version.previewError).toContain("soffice unavailable");
    expect(version.previewAssetId).toBeNull();
  });

  it("isolates LibreOffice and explicitly exposes the bundled Chinese font to fontconfig", async () => {
    const workDirectory = await mkdtemp(path.join(tmpdir(), "policy-office-runtime-"));
    const fontDirectory = path.join(workDirectory, "fonts");
    await mkdir(fontDirectory);
    await writeFile(path.join(fontDirectory, "NotoSansCJKsc-Regular.otf"), "font fixture");

    try {
      const runtime = await prepareOfficeConversionRuntime(workDirectory, { fontDirectory });
      expect(runtime.userInstallationArg).toMatch(/^-env:UserInstallation=file:/);
      expect(runtime.env.FONTCONFIG_PATH).toBe(path.join(workDirectory, "fontconfig"));
      expect(runtime.env.FONTCONFIG_FILE).toBe("fonts.conf");
      expect(runtime.env.SAL_FONTPATH).toBe(fontDirectory);
      const config = await readFile(path.join(workDirectory, "fontconfig", "fonts.conf"), "utf8");
      expect(config).toContain("Noto Sans CJK SC");
      expect(config).toContain("SimSun");
      expect(config).toContain("宋体");
      expect(config).toContain(fontDirectory);
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });
});

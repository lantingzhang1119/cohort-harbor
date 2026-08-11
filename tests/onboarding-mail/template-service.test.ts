import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  FileAssetKind,
  OnboardingMaterialStatus,
  OnboardingMailAttachmentRole,
  OnboardingMailCcKind,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { uploadMailAsset, validateMailAsset, verifyPersistedMailAsset } from "@/features/onboarding-mail/asset-service";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import {
  DEFAULT_ENCODED_MIME_LIMIT,
  DEFAULT_RAW_ATTACHMENT_LIMIT,
  MailMessageSizeError,
  TRANSPORT_HEADER_ALLOWANCE_BYTES,
  assertMailMessageSize,
  encodedBase64SizeWithWrapping,
  estimateMimeMessageSize,
  guardMessageBeforeDispatch,
  writeMimeMessageToSink,
  type MimeMessageInput,
} from "@/features/onboarding-mail/message-size";
import {
  previewWelcomeTemplate,
  publishTemplate,
  renderWelcomeTemplate,
  saveTemplateDraft,
  type WelcomeMailPreview,
} from "@/features/onboarding-mail/template-service";
import type { TemplateDraft } from "@/features/onboarding-mail/template-schemas";
import { createTestDatabase } from "../helpers/test-db";
import { validGif, validPng } from "../fixtures/portal-images";
import { createPrismaClient } from "@/lib/db/create-client";

type PreviewAttachment = Awaited<ReturnType<typeof previewWelcomeTemplate>>["attachments"][number];
type PreviewAttachmentHasNoDatabaseId = "id" extends keyof PreviewAttachment ? never : true;
const previewAttachmentHasNoDatabaseId: PreviewAttachmentHasNoDatabaseId = true;

function upload(fileName: string, mimeType: string, bytes: Uint8Array, declaredSize = bytes.byteLength): UploadFileLike {
  return {
    fileName,
    mimeType,
    size: declaredSize,
    stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  };
}

async function user(db: PrismaClient, employeeNo: string, role: Role, email = `${employeeNo.toLowerCase()}@example.invalid`) {
  return db.user.create({ data: {
    employeeNo,
    name: `${employeeNo} 姓名`,
    email,
    role,
    sourceType: UserSource.MANUAL,
    passwordHash: "not-used-in-service-tests",
    hiredAt: new Date("2026-07-22T00:00:00.000Z"),
    firstDepartment: "研发中心",
    secondDepartment: "平台组",
    position: "工程师",
    workLocation: "SHANGHAI",
  } });
}

function draft(templateId: string, overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    templateId,
    senderDisplayName: "人力资源部",
    subject: "欢迎 {{name}}",
    htmlBody: '<p style="color:#123456" onclick="evil()">欢迎 <strong>{{name}}</strong></p><script>bad()</script>',
    textBody: "欢迎 {{name}}",
    fieldConfig: [{
      key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 10, required: true,
    }],
    styleConfig: { theme: "corporate" },
    attachments: [],
    ccEntries: [],
    ...overrides,
  };
}

describe("welcome-mail template publication", () => {
  it("applies a published inline background CID to preview and rendered email HTML", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-background-"));
    try {
      const admin = await user(testDb.db, "ADMIN-BACKGROUND", Role.ADMIN);
      const employee = await user(testDb.db, "EMP-BACKGROUND", Role.EMPLOYEE);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "背景语义",
      } });
      const asset = await uploadMailAsset(admin.id, upload("background.gif", "image/gif", validGif("89a")), {
        role: OnboardingMailAttachmentRole.INLINE_BACKGROUND, contentId: "welcome-background",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const bodyAsset = await uploadMailAsset(admin.id, upload("body.gif", "image/gif", validGif("89a")), {
        role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "welcome-body",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const input = draft(template.id, {
        htmlBody: '<p>欢迎 {{name}}</p><img src="cid:welcome-body" alt="欢迎图">',
        styleConfig: { backgroundContentId: "welcome-background" },
        attachments: [{
          role: OnboardingMailAttachmentRole.INLINE_BACKGROUND,
          fileAssetId: asset.id,
          displayName: "background.gif",
          contentId: "welcome-background",
          sortOrder: 1,
        }, {
          role: OnboardingMailAttachmentRole.INLINE_BODY,
          fileAssetId: bodyAsset.id,
          displayName: "body.gif",
          contentId: "welcome-body",
          sortOrder: 2,
        }],
      });

      const preview = await previewWelcomeTemplate(admin.id, input, employee.id, { db: testDb.db, privateRoot });
      const revision = await publishTemplate(admin.id, input, { db: testDb.db, privateRoot });
      const rendered = await renderWelcomeTemplate(revision.id, employee.id, { db: testDb.db });

      expect(preview.html).toContain(`background-image: url(/api/admin/onboarding-mail/assets/${asset.id}/preview)`);
      expect(preview.html).toContain(`src="/api/admin/onboarding-mail/assets/${bodyAsset.id}/preview"`);
      expect(preview.html).not.toContain(privateRoot);
      expect(rendered.html).toContain("background-image: url(cid:welcome-background)");
      expect(rendered.html).toContain('src="cid:welcome-body"');
      expect(rendered.attachments).toEqual([
        expect.objectContaining({ role: OnboardingMailAttachmentRole.INLINE_BACKGROUND, contentId: "welcome-background" }),
        expect.objectContaining({ role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "welcome-body" }),
      ]);
    } finally {
      await testDb.cleanup();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });

  it("rejects CR/LF in transport-bound sender names, subjects and constants", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-HEADER", Role.ADMIN);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "邮件头约束",
      } });
      await expect(saveTemplateDraft(admin.id, draft(template.id, {
        senderDisplayName: "HR\r\nBcc: attacker@example.invalid",
      }), { db: testDb.db })).rejects.toBeInstanceOf(Error);
      await expect(saveTemplateDraft(admin.id, draft(template.id, {
        subject: "欢迎\nBcc: attacker@example.invalid",
      }), { db: testDb.db })).rejects.toBeInstanceOf(Error);
      await expect(saveTemplateDraft(admin.id, draft(template.id, {
        fieldConfig: [{
          key: "custom.header", kind: "CONSTANT", label: "常量", enabled: true,
          sortOrder: 1, required: false, constantValue: "safe\r\nBcc: attacker@example.invalid",
        }],
        subject: "{{custom.header}}",
      }), { db: testDb.db })).rejects.toBeInstanceOf(Error);
    } finally {
      await testDb.cleanup();
    }
  });

  it("gives ADMIN and SUPER_ADMIN equal draft/publish rights but denies employees", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-1", Role.ADMIN);
      const superAdmin = await user(testDb.db, "SUPER-1", Role.SUPER_ADMIN);
      const employee = await user(testDb.db, "EMP-1", Role.EMPLOYEE);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });

      await expect(saveTemplateDraft(admin.id, draft(template.id), { db: testDb.db })).resolves.toMatchObject({ id: template.id });
      await expect(publishTemplate(superAdmin.id, draft(template.id), { db: testDb.db })).resolves.toMatchObject({ revisionNumber: 1 });
      await expect(saveTemplateDraft(employee.id, draft(template.id), { db: testDb.db }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });

      const malformed = { ...draft(template.id), subject: "", htmlBody: "x".repeat(1_000_001) } as TemplateDraft;
      await expect(saveTemplateDraft(employee.id, malformed, { db: testDb.db }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(publishTemplate(employee.id, malformed, { db: testDb.db }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await testDb.cleanup();
    }
  });

  it("provides an authorized non-persisting preview with selected employee fields and a real PREVIEW sanitation boundary", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-PREVIEW", Role.ADMIN);
      const employee = await user(testDb.db, "EMP-PREVIEW", Role.EMPLOYEE);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });
      const previewDraft = draft(template.id, {
        subject: "{{companyName}}欢迎 {{name}}",
        htmlBody: '<p onclick="evil()">预览 {{name}}</p><script>escape()</script>',
        textBody: "预览 {{name}}",
        fieldConfig: [
          { key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 10, required: true },
          { key: "companyName", kind: "BUILTIN", label: "公司名称", enabled: true, sortOrder: 20, required: true },
        ],
      });

      const preview: WelcomeMailPreview = await previewWelcomeTemplate(admin.id, previewDraft, employee.id, { db: testDb.db });
      expect(previewAttachmentHasNoDatabaseId).toBe(true);
      expect(preview.subject).toBe("CohortHarbor欢迎 EMP-PREVIEW 姓名");
      expect(preview.html).toBe("<p>预览 EMP-PREVIEW 姓名</p>");
      expect(preview.html).not.toMatch(/onclick|script|escape/i);
      expect((await testDb.db.onboardingMailTemplate.findUniqueOrThrow({ where: { id: template.id } })).draftSubject).toBeNull();

      const malformed = { ...previewDraft, subject: "", htmlBody: "x".repeat(1_000_001) } as TemplateDraft;
      await expect(previewWelcomeTemplate(employee.id, malformed, employee.id, { db: testDb.db }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await testDb.cleanup();
    }
  });

  it("sanitizes drafts and freezes fields, exact material versions, standalone assets, attachments and CC per immutable revision", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-freeze-"));
    try {
      const admin = await user(testDb.db, "ADMIN-2", Role.ADMIN);
      const ccUser = await user(testDb.db, "CC-1", Role.EMPLOYEE, "first@example.invalid");
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });
      const standalone = await uploadMailAsset(admin.id, upload("logo.png", "image/png", validPng()), {
        role: OnboardingMailAttachmentRole.INLINE_LOGO,
        contentId: "logo-1",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const materialAsset = await testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.ONBOARDING_MATERIAL,
        storageKey: "materials/v1.txt", originalName: "guide.txt", mimeType: "text/plain", sizeBytes: 12, sha256: "material-v1",
        uploadedById: admin.id, uploadedBySnapshot: {},
      } });
      const material = await testDb.db.onboardingMaterial.create({ data: {
        title: "手册", category: "入职", status: OnboardingMaterialStatus.PUBLISHED,
        createdById: admin.id, createdBySnapshot: {}, updatedById: admin.id, updatedBySnapshot: {},
      } });
      const version1 = await testDb.db.onboardingMaterialVersion.create({ data: {
        materialId: material.id, versionNumber: 1, fileAssetId: materialAsset.id,
        originalName: "guide.txt", displayName: "入职手册.txt", extension: ".txt", mimeType: "text/plain", sizeBytes: 12,
        sha256: "material-v1", uploadedById: admin.id, uploadedBySnapshot: {},
      } });
      await testDb.db.onboardingMaterial.update({ where: { id: material.id }, data: { currentVersionId: version1.id } });

      const firstDraft = draft(template.id, {
        attachments: [
          { role: OnboardingMailAttachmentRole.INLINE_LOGO, fileAssetId: standalone.id, displayName: "logo.png", contentId: "logo-1", sortOrder: 10 },
          { role: OnboardingMailAttachmentRole.ATTACHMENT, materialVersionId: version1.id, displayName: "入职手册.txt", sortOrder: 20 },
        ],
        ccEntries: [
          { kind: OnboardingMailCcKind.USER, userId: ccUser.id, displayName: "CC-1 姓名", sortOrder: 10 },
          { kind: OnboardingMailCcKind.EMAIL, email: "external@example.org", displayName: "外部顾问", sortOrder: 20 },
        ],
      });
      await saveTemplateDraft(admin.id, firstDraft, { db: testDb.db, privateRoot });
      const storedDraft = await testDb.db.onboardingMailTemplate.findUniqueOrThrow({ where: { id: template.id } });
      expect(storedDraft.draftHtmlBody).not.toMatch(/onclick|script/i);

      const revision1 = await publishTemplate(admin.id, firstDraft, { db: testDb.db, privateRoot });
      expect(revision1.htmlBody).not.toMatch(/onclick|script/i);
      expect(revision1.fieldConfig).toEqual(firstDraft.fieldConfig);
      expect(revision1.attachments.map((item) => [item.role, item.fileAssetId, item.materialVersionId, item.contentId])).toEqual([
        [OnboardingMailAttachmentRole.INLINE_LOGO, standalone.id, null, "logo-1"],
        [OnboardingMailAttachmentRole.ATTACHMENT, null, version1.id, null],
      ]);
      expect(revision1.ccEntries[0].userSnapshot).toMatchObject({ id: ccUser.id, email: "first@example.invalid" });
      expect(revision1.ccEntries[1].email).toBe("external@example.org");

      await testDb.db.user.update({ where: { id: ccUser.id }, data: { email: "late-bound@example.invalid" } });
      const revision2 = await publishTemplate(admin.id, draft(template.id, { subject: "第二版 {{name}}" }), { db: testDb.db });
      const unchanged = await testDb.db.onboardingMailTemplateRevision.findUniqueOrThrow({
        where: { id: revision1.id }, include: { attachments: true, ccEntries: true },
      });
      expect(revision2.revisionNumber).toBe(2);
      expect(unchanged.subject).toBe("欢迎 {{name}}");
      expect(unchanged.attachments[1].materialVersionId).toBe(version1.id);
      expect(unchanged.ccEntries[0].userSnapshot).toMatchObject({ email: "first@example.invalid" });
    } finally {
      await testDb.cleanup();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });

  it("accepts only the current version of a published onboarding material", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-MATERIAL", Role.ADMIN);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });
      const createMaterial = async (suffix: string, status: OnboardingMaterialStatus) => {
        const material = await testDb.db.onboardingMaterial.create({ data: {
          title: `手册 ${suffix}`, category: "入职", status,
          createdById: admin.id, createdBySnapshot: {}, updatedById: admin.id, updatedBySnapshot: {},
        } });
        const versions = [];
        for (const versionNumber of [1, 2]) {
          const asset = await testDb.db.fileAsset.create({ data: {
            kind: FileAssetKind.ONBOARDING_MATERIAL,
            storageKey: `materials/${suffix}-${versionNumber}.txt`, originalName: `${suffix}-${versionNumber}.txt`,
            mimeType: "text/plain", sizeBytes: 12, sha256: `${suffix}-${versionNumber}`,
            uploadedById: admin.id, uploadedBySnapshot: {},
          } });
          versions.push(await testDb.db.onboardingMaterialVersion.create({ data: {
            materialId: material.id, versionNumber, fileAssetId: asset.id,
            originalName: asset.originalName, displayName: asset.originalName, extension: ".txt",
            mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256,
            uploadedById: admin.id, uploadedBySnapshot: {},
          } }));
        }
        await testDb.db.onboardingMaterial.update({
          where: { id: material.id }, data: { currentVersionId: versions[1].id },
        });
        return versions;
      };
      const published = await createMaterial("published", OnboardingMaterialStatus.PUBLISHED);
      const draftMaterial = await createMaterial("draft", OnboardingMaterialStatus.DRAFT);
      const archived = await createMaterial("archived", OnboardingMaterialStatus.ARCHIVED);
      const withMaterial = (materialVersionId: string) => draft(template.id, { attachments: [{
        role: OnboardingMailAttachmentRole.ATTACHMENT,
        materialVersionId,
        displayName: "入职手册.txt",
        sortOrder: 10,
      }] });

      await expect(saveTemplateDraft(admin.id, withMaterial(published[1].id), { db: testDb.db })).resolves.toBeDefined();
      for (const invalidVersionId of [published[0].id, draftMaterial[1].id, archived[1].id]) {
        await expect(saveTemplateDraft(admin.id, withMaterial(invalidVersionId), { db: testDb.db }))
          .rejects.toMatchObject({ code: "INVALID_MATERIAL_VERSION" });
      }
    } finally {
      await testDb.cleanup();
    }
  });

  it("renders from the frozen revision and employee fields with send-boundary sanitation", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-3", Role.ADMIN);
      const employee = await user(testDb.db, "EMP-3", Role.EMPLOYEE);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });
      const revision = await publishTemplate(admin.id, draft(template.id), { db: testDb.db });
      const rendered = await renderWelcomeTemplate(revision.id, employee.id, { db: testDb.db, companyName: "Example Organization" });
      expect(rendered).toMatchObject({
        recipient: { employeeId: employee.id, email: "emp-3@example.invalid" },
        subject: "欢迎 EMP-3 姓名",
        text: "欢迎 EMP-3 姓名",
      });
      expect(rendered.html).toContain("<strong>EMP-3 姓名</strong>");
      expect(rendered.html).not.toMatch(/onclick|script/i);
    } finally {
      await testDb.cleanup();
    }
  });

  it("allocates distinct consecutive revisions across independent Prisma clients", async () => {
    const testDb = await createTestDatabase();
    const first = createPrismaClient(testDb.databaseUrl, { busyTimeoutMs: 100 });
    const second = createPrismaClient(testDb.databaseUrl, { busyTimeoutMs: 100 });
    try {
      const admin = await user(testDb.db, "ADMIN-CONCURRENT", Role.ADMIN);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "并发发布",
      } });
      const revisions = await Promise.all([
        publishTemplate(admin.id, draft(template.id, { subject: "并发 A {{name}}" }), { db: first }),
        publishTemplate(admin.id, draft(template.id, { subject: "并发 B {{name}}" }), { db: second }),
      ]);
      expect(revisions.map((revision) => revision.revisionNumber).sort()).toEqual([1, 2]);
      expect(await testDb.db.onboardingMailTemplateRevision.count({ where: { templateId: template.id } })).toBe(2);
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
      await testDb.cleanup();
    }
  });

  it("rejects a non-image stored mail asset when referenced by an inline role", async () => {
    const testDb = await createTestDatabase();
    try {
      const admin = await user(testDb.db, "ADMIN-4", Role.ADMIN);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "新人欢迎信",
      } });
      const textAsset = await testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.ONBOARDING_EMAIL_ASSET,
        storageKey: "mail/readme.txt", originalName: "readme.txt", mimeType: "text/plain", sizeBytes: 4, sha256: "safe-text",
        uploadedById: admin.id, uploadedBySnapshot: {},
      } });

      await expect(publishTemplate(admin.id, draft(template.id, {
        attachments: [{
          role: OnboardingMailAttachmentRole.INLINE_BODY,
          fileAssetId: textAsset.id,
          displayName: "伪装内嵌图.txt",
          contentId: "body-1",
          sortOrder: 1,
        }],
      }), { db: testDb.db })).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
    } finally {
      await testDb.cleanup();
    }
  });
});

describe("welcome-mail asset validation", () => {
  it("accepts signature-valid CID images and safe Task 4 attachments", async () => {
    const inline = await validateMailAsset(upload("logo.png", "image/png", validPng()), {
      role: OnboardingMailAttachmentRole.INLINE_LOGO, contentId: "logo-1",
    }, { maxBytes: 1024 * 1024 });
    const attachment = await validateMailAsset(upload("readme.txt", "text/plain", Buffer.from("safe", "utf8")), {
      role: OnboardingMailAttachmentRole.ATTACHMENT,
    }, { maxBytes: 1024 * 1024 });
    expect(inline.contentId).toBe("logo-1");
    expect(attachment.validated.mimeType).toBe("text/plain");
    await inline.validated.cleanup();
    await attachment.validated.cleanup();
  });

  it.each([
    ["forged image", upload("fake.png", "image/png", Buffer.from("not-a-png")), OnboardingMailAttachmentRole.INLINE_BODY, "hero"],
    ["SVG", upload("vector.svg", "image/svg+xml", Buffer.from("<svg/>")), OnboardingMailAttachmentRole.INLINE_BODY, "hero"],
    ["HTML", upload("page.html", "text/html", Buffer.from("<script/>")), OnboardingMailAttachmentRole.ATTACHMENT, undefined],
    ["double extension", upload("invoice.exe.pdf", "application/pdf", Buffer.from("%PDF-1.7")), OnboardingMailAttachmentRole.ATTACHMENT, undefined],
    ["malformed Office", upload("broken.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK-broken")), OnboardingMailAttachmentRole.ATTACHMENT, undefined],
    ["oversize", upload("large.txt", "text/plain", Buffer.alloc(10)), OnboardingMailAttachmentRole.ATTACHMENT, undefined],
  ] as const)("rejects %s", async (_case, file, role, contentId) => {
    await expect(validateMailAsset(file, { role, contentId }, { maxBytes: _case === "oversize" ? 9 : 1024 * 1024 }))
      .rejects.toBeInstanceOf(Error);
  });

  it("persists a validated asset privately with immutable metadata and audit, and cleans storage on transaction failure", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-upload-"));
    try {
      const admin = await user(testDb.db, "ADMIN-UPLOAD", Role.ADMIN);
      const employee = await user(testDb.db, "EMP-UPLOAD", Role.EMPLOYEE);
      const bytes = validPng();
      const created = await uploadMailAsset(admin.id, upload("brand.png", "image/png", bytes), {
        role: OnboardingMailAttachmentRole.INLINE_LOGO,
        contentId: "brand-logo",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const stored = await testDb.db.fileAsset.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored).toMatchObject({
        kind: FileAssetKind.ONBOARDING_EMAIL_ASSET,
        originalName: "brand.png",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        uploadedById: admin.id,
      });
      expect(stored.storageKey).toMatch(/^onboarding\/mail-assets\/[0-9a-f-]+\.png$/);
      expect(await readFile(path.join(privateRoot, stored.storageKey))).toEqual(Buffer.from(bytes));
      expect(await testDb.db.auditLog.findFirst({ where: { action: "ONBOARDING_MAIL_ASSET_UPLOAD", targetId: created.id } })).not.toBeNull();

      await expect(uploadMailAsset(employee.id, upload("forged.png", "image/png", Buffer.from("bad")), {
        role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "forged",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "FORBIDDEN" });

      const injected = new Error("after-create");
      await expect(uploadMailAsset(admin.id, upload("rollback.png", "image/png", bytes), {
        role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "rollback",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024, hooks: {
        afterAssetCreate: () => { throw injected; },
      } })).rejects.toBe(injected);
      expect(await testDb.db.fileAsset.count({ where: { originalName: "rollback.png" } })).toBe(0);
      expect((await readdir(path.join(privateRoot, "onboarding/mail-assets"))).length).toBe(1);
    } finally {
      await testDb.cleanup();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });

  it("re-checks persisted bytes, hash and signature before freezing an uploaded asset", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-integrity-"));
    try {
      const admin = await user(testDb.db, "ADMIN-INTEGRITY", Role.ADMIN);
      const template = await testDb.db.onboardingMailTemplate.create({ data: {
        kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "完整性",
      } });
      const asset = await uploadMailAsset(admin.id, upload("body.gif", "image/gif", validGif("89a")), {
        role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "body-image",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const input = draft(template.id, {
        htmlBody: '<p>欢迎 {{name}}</p><img src="cid:body-image">',
        attachments: [{
          role: OnboardingMailAttachmentRole.INLINE_BODY,
          fileAssetId: asset.id,
          displayName: "body.gif",
          contentId: "body-image",
          sortOrder: 1,
        }],
      });
      await saveTemplateDraft(admin.id, input, { db: testDb.db, privateRoot });
      const stored = await testDb.db.fileAsset.findUniqueOrThrow({ where: { id: asset.id } });
      await writeFile(path.join(privateRoot, stored.storageKey), validGif("87a"));
      await expect(publishTemplate(admin.id, input, { db: testDb.db, privateRoot }))
        .rejects.toMatchObject({ code: "ASSET_INTEGRITY_MISMATCH" });
      expect(await testDb.db.onboardingMailTemplateRevision.count()).toBe(0);
    } finally {
      await testDb.cleanup();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });

  it("rejects an oversized persisted file from opened-handle metadata before bounded validation", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-oversized-"));
    try {
      const admin = await user(testDb.db, "ADMIN-OVERSIZED", Role.ADMIN);
      const asset = await uploadMailAsset(admin.id, upload("large.png", "image/png", validPng()), {
        role: OnboardingMailAttachmentRole.INLINE_BODY, contentId: "large-image",
      }, { db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
      const stored = await testDb.db.fileAsset.findUniqueOrThrow({ where: { id: asset.id } });
      await truncate(path.join(privateRoot, stored.storageKey), 1024 * 1024 + 1);

      await expect(verifyPersistedMailAsset(stored, {
        role: OnboardingMailAttachmentRole.INLINE_BODY,
        contentId: "large-image",
      }, { privateRoot, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });
    } finally {
      await testDb.cleanup();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });
});

describe("full MIME size accounting", () => {
  const message: MimeMessageInput = {
    from: "HR <hr@example.invalid>",
    to: ["new.hire@example.invalid"],
    cc: ["manager@example.invalid"],
    subject: "欢迎入职",
    html: "<p>欢迎</p>",
    text: "欢迎",
    attachments: [{ fileName: "payload.bin", mimeType: "application/octet-stream", bytes: Buffer.alloc(58) }],
    inlineResources: [{ fileName: "logo.png", mimeType: "image/png", contentId: "logo-1", bytes: Buffer.alloc(57) }],
  };

  it("uses the 20 MiB raw and 25 MiB encoded defaults and handles Base64 modulo/line wrapping boundaries", () => {
    expect(DEFAULT_RAW_ATTACHMENT_LIMIT).toBe(20 * 1024 * 1024);
    expect(DEFAULT_ENCODED_MIME_LIMIT).toBe(25 * 1024 * 1024);
    expect(encodedBase64SizeWithWrapping(0)).toBe(0);
    expect(encodedBase64SizeWithWrapping(1)).toBe(6);
    expect(encodedBase64SizeWithWrapping(57)).toBe(78);
    expect(encodedBase64SizeWithWrapping(58)).toBe(84);
  });

  it("includes headers, HTML, text, attachments and inline resources and matches a counting sink", async () => {
    let counted = 0;
    await writeMimeMessageToSink(message, { write(chunk) { counted += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength; } });
    expect(estimateMimeMessageSize(message)).toBe(counted);
    expect(counted).toBeGreaterThan(58 + 57 + Buffer.byteLength(message.html) + Buffer.byteLength(message.text));
  });

  it("models Unicode bodies with the transport Base64 encoding and reserves unmodelled transport headers", async () => {
    const unicode = {
      ...message,
      text: "CohortHarbor欢迎你加入团队".repeat(100),
      html: `<p>${"欢迎开启入职学习旅程".repeat(100)}</p>`,
    };
    let serialized = "";
    await writeMimeMessageToSink(unicode, { write(chunk) { serialized += Buffer.from(chunk).toString(); } });

    expect(serialized).toContain("Content-Transfer-Encoding: base64");
    expect(serialized).not.toContain("欢迎开启入职学习旅程");
    const estimated = estimateMimeMessageSize(unicode);
    expect(() => assertMailMessageSize(unicode, {
      rawAttachmentMaxBytes: 115,
      encodedMimeMaxBytes: estimated,
    })).toThrow(MailMessageSizeError);
    expect(() => assertMailMessageSize(unicode, {
      rawAttachmentMaxBytes: 115,
      encodedMimeMaxBytes: estimated + TRANSPORT_HEADER_ALLOWANCE_BYTES,
    })).not.toThrow();
  });

  it("includes resolved CC display names in the pre-dispatch size model", () => {
    const withoutName = estimateMimeMessageSize({ ...message, cc: ["manager@example.invalid"] });
    const displayName = "经".repeat(120);
    const withName = estimateMimeMessageSize({
      ...message,
      cc: [{ email: "manager@example.invalid", displayName }],
    });

    expect(withName - withoutName).toBeGreaterThanOrEqual(Buffer.byteLength(displayName));
  });

  it.each(["attachment", "inline"] as const)("keeps the transport allowance above Nodemailer's configured %s header maxima", async (kind) => {
    const cc = Array.from({ length: 100 }, (_, index) => {
      const local = `${index.toString().padStart(3, "0")}${"a".repeat(61)}`;
      return `${local}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    });
    const binaryParts = Array.from({ length: 100 }, (_, index) => ({
      fileName: "资".repeat(240),
      mimeType: "image/png",
      bytes: Buffer.alloc(0),
      ...(kind === "inline" ? { contentId: `cid-${index}-${"x".repeat(119)}` } : {}),
    }));
    const boundaryMessage: MimeMessageInput = {
      ...message,
      from: "发".repeat(120),
      cc: cc.map((email) => ({ email, displayName: "抄".repeat(120) })),
      subject: "主".repeat(500),
      attachments: kind === "attachment" ? binaryParts : [],
      inlineResources: kind === "inline" ? binaryParts : [],
    };
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: false,
      newline: "windows",
    });
    const result = await transport.sendMail({
      from: { name: boundaryMessage.from, address: "sender@example.invalid" },
      to: boundaryMessage.to,
      cc: cc.map((address) => ({ name: "抄".repeat(120), address })),
      subject: boundaryMessage.subject,
      text: boundaryMessage.text,
      html: boundaryMessage.html,
      textEncoding: "base64",
      attachments: binaryParts.map((attachment) => ({
        filename: attachment.fileName,
        contentType: attachment.mimeType,
        content: Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes),
        ...(attachment.contentId ? { cid: attachment.contentId } : {}),
      })),
    });
    let transportBytes = 0;
    if (Buffer.isBuffer(result.message)) transportBytes = result.message.byteLength;
    else for await (const chunk of result.message) transportBytes += Buffer.byteLength(chunk);
    const modelledBytes = estimateMimeMessageSize(boundaryMessage);

    // These schema maxima prove the old 64 KiB cushion was unsafe while the
    // pinned Nodemailer output remains below half the conservative bound.
    // Keeping at least a 2x measured margin prevents a dependency update from
    // turning harmless RFC 2047/2231 header growth into a post-acceptance
    // transport rejection.
    expect(transportBytes).toBeGreaterThan(modelledBytes + 64 * 1024);
    expect(TRANSPORT_HEADER_ALLOWANCE_BYTES).toBeGreaterThanOrEqual(
      (transportBytes - modelledBytes) * 2,
    );
    expect(transportBytes).toBeLessThanOrEqual(modelledBytes + TRANSPORT_HEADER_ALLOWANCE_BYTES);
  });

  it("measures binary parts without Base64-encoding them and stays byte-exact across boundary sizes", async () => {
    const originalToString = Buffer.prototype.toString;
    let base64Calls = 0;
    const toStringSpy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (...args) {
      if (args[0] === "base64") base64Calls += 1;
      return originalToString.apply(this, args as Parameters<Buffer["toString"]>);
    });
    const sizes = [0, 1, 2, 3, 56, 57, 58, 75, 76, 77, 1_023, 1_024];
    let seed = 0x5eed1234;
    for (let index = 0; index < 24; index += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      sizes.push(seed % 8_192);
    }

    try {
      for (const size of sizes) {
        const input: MimeMessageInput = {
          ...message,
          attachments: [{
            fileName: `payload-${size}.bin`,
            mimeType: "application/octet-stream",
            bytes: Buffer.alloc(size, 0xa5),
          }],
          inlineResources: [],
        };
        const measured = estimateMimeMessageSize(input);
        expect(base64Calls).toBe(0);
        let serializedBytes = 0;
        await writeMimeMessageToSink(input, {
          write(chunk) { serializedBytes += Buffer.byteLength(chunk); },
        });
        expect(measured).toBe(serializedBytes);
        base64Calls = 0;
      }
    } finally {
      toStringSpy.mockRestore();
    }
  });

  it("allows exact raw/encoded limits and rejects one byte below before dispatchedAt", async () => {
    const estimated = estimateMimeMessageSize(message) + TRANSPORT_HEADER_ALLOWANCE_BYTES;
    let dispatchedAt: Date | null = null;
    await expect(guardMessageBeforeDispatch(message, async () => { dispatchedAt = new Date(); }, {
      rawAttachmentMaxBytes: 115,
      encodedMimeMaxBytes: estimated,
    })).resolves.toBeUndefined();
    expect(dispatchedAt).toBeInstanceOf(Date);

    dispatchedAt = null;
    await expect(guardMessageBeforeDispatch(message, async () => { dispatchedAt = new Date(); }, {
      rawAttachmentMaxBytes: 115,
      encodedMimeMaxBytes: estimated - 1,
    })).rejects.toBeInstanceOf(MailMessageSizeError);
    expect(dispatchedAt).toBeNull();
  });

  it("chooses boundaries that do not collide with administrator-controlled text or HTML", async () => {
    const collision = "--cohort-harbor-mixed-boundary";
    const hostile = { ...message, text: `safe\r\n${collision}\r\nContent-Type: application/x-hostile`, html: `<p>${collision}</p>` };
    let serialized = "";
    await writeMimeMessageToSink(hostile, { write(chunk) { serialized += Buffer.from(chunk).toString(); } });
    expect(serialized).not.toContain('boundary="cohort-harbor-mixed-boundary"');
    expect(estimateMimeMessageSize(hostile)).toBe(Buffer.byteLength(serialized));
  });

  it("uses independent high-entropy boundaries and nests inline CID parts under multipart/related", async () => {
    let serialized = "";
    await writeMimeMessageToSink(message, { write(chunk) { serialized += Buffer.from(chunk).toString(); } });
    const boundaries = [...serialized.matchAll(/boundary="(=_cohort-harbor_(?:mixed|related|alternative)_[a-f0-9]{48})"/g)]
      .map((match) => match[1]);
    expect(boundaries).toHaveLength(3);
    expect(new Set(boundaries).size).toBe(3);
    expect(serialized).toContain("Content-Type: multipart/related");
    const relatedClose = serialized.indexOf(`--${boundaries.find((value) => value.includes("related"))}--`);
    expect(serialized.indexOf("Content-ID: <logo-1>")).toBeLessThan(relatedClose);
    expect(serialized.indexOf('Content-Disposition: attachment; filename="payload.bin"')).toBeGreaterThan(relatedClose);
  });

  it("bounds adversarial boundary collisions and fails closed", async () => {
    const token = "a".repeat(48);
    const collision = `=_cohort-harbor_mixed_${token}`;
    const hostile = { ...message, text: `${collision}\n${collision}\n${collision}` };
    let attempts = 0;
    await expect(writeMimeMessageToSink(hostile, { write() {} }, {
      maxBoundaryAttempts: 3,
      boundaryTokenFactory: () => { attempts += 1; return token; },
    })).rejects.toMatchObject({ code: "MIME_BOUNDARY_COLLISION" });
    expect(attempts).toBe(3);
  });
});

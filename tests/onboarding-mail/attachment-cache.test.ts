import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  FileAssetKind,
  OnboardingMailAttachmentRole,
  OnboardingMailDeliverySource,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { createWelcomeDelivery } from "@/features/onboarding-mail/delivery-service";
import { verifyPersistedMailAsset } from "@/features/onboarding-mail/asset-service";
import {
  createMailAttachmentCache,
  loadVerifiedRevisionAttachments,
} from "@/features/onboarding-mail/delivery-service";
import { runOnboardingMailCycle } from "@/features/onboarding-mail/outbox-worker";
import { createTestDatabase } from "../helpers/test-db";

const now = new Date("2026-07-22T04:00:00.000Z");
const payload = Buffer.from("shared attachment", "utf8");

async function attachmentFixture(db: PrismaClient, privateRoot: string, storedBytes = payload) {
  const template = await db.onboardingMailTemplate.create({ data: {
    kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME,
    name: `attachment-${Math.random()}`,
    enabled: true,
  } });
  const revision = await db.onboardingMailTemplateRevision.create({ data: {
    templateId: template.id,
    revisionNumber: 1,
    senderDisplayName: "HR",
    subject: "欢迎 {{name}}",
    htmlBody: "<p>欢迎 {{name}}</p>",
    textBody: "欢迎 {{name}}",
    fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
    styleConfig: {},
    publishedBySnapshot: {},
  } });
  const storageKey = `onboarding/mail-assets/${revision.id}.txt`;
  const absolutePath = path.join(privateRoot, storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, storedBytes);
  const asset = await db.fileAsset.create({ data: {
    kind: FileAssetKind.ONBOARDING_EMAIL_ASSET,
    storageKey,
    originalName: "shared.txt",
    mimeType: "text/plain",
    sizeBytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    uploadedBySnapshot: {},
  } });
  await db.onboardingMailRevisionAttachment.create({ data: {
    revisionId: revision.id,
    role: OnboardingMailAttachmentRole.ATTACHMENT,
    fileAssetId: asset.id,
    displayName: "入职资料.txt",
    sortOrder: 1,
  } });
  return { revision, asset, absolutePath };
}

async function addDelivery(db: PrismaClient, revisionId: string, index: number) {
  const employee = await db.user.create({ data: {
    employeeNo: `CACHE-${index}-${Math.random()}`,
    name: `员工${index}`,
    email: `cache-${index}-${Math.random()}@example.invalid`,
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    passwordHash: "unused",
    hiredAt: now,
  } });
  return createWelcomeDelivery({
    source: OnboardingMailDeliverySource.MANUAL,
    recipientId: employee.id,
    templateRevisionId: revisionId,
    scheduledLocalDate: null,
    scheduledAt: now,
  }, { db, now: () => now });
}

describe("cycle-scoped mail attachment loading", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-cache-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  it("verifies and reads a frozen revision attachment only once for two deliveries in one worker cycle", async () => {
    const { revision, absolutePath } = await attachmentFixture(testDb.db, privateRoot);
    await addDelivery(testDb.db, revision.id, 1);
    await addDelivery(testDb.db, revision.id, 2);
    let sends = 0;
    const send = vi.fn(async (message: { attachments: Array<{ bytes: Uint8Array }> }) => {
      sends += 1;
      expect(Buffer.from(message.attachments[0].bytes)).toEqual(payload);
      if (sends === 1) await unlink(absolutePath);
      return { kind: "accepted", providerMessageId: null, responseSummary: null, protocolStage: "POST_DATA", ccRejectedCount: 0 } as const;
    });

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "attachment-cache-worker",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      privateRoot,
    });

    expect(summary).toMatchObject({ claimed: 2, processed: 2, sent: 2, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(2);

    await addDelivery(testDb.db, revision.id, 3);
    const nextCycleSend = vi.fn();
    const next = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send: nextCycleSend },
      workerId: "attachment-next-cycle",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      privateRoot,
    });
    expect(next).toMatchObject({ claimed: 1, processed: 1, sent: 0, skipped: 1 });
    expect(nextCycleSend).not.toHaveBeenCalled();
  });

  it("evicts a rejected attachment promise so the same cycle cache can retry after repair", async () => {
    const badBytes = Buffer.from("shared attachmenX", "utf8");
    expect(badBytes.byteLength).toBe(payload.byteLength);
    const { revision, absolutePath } = await attachmentFixture(testDb.db, privateRoot, badBytes);
    const cache = createMailAttachmentCache();

    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot, cache))
      .rejects.toMatchObject({ code: "ASSET_INTEGRITY_MISMATCH" });
    expect(cache.size).toBe(0);

    await writeFile(absolutePath, payload);
    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot, cache))
      .resolves.toEqual([expect.objectContaining({ fileName: "入职资料.txt", bytes: payload })]);
    expect(cache.size).toBe(1);
  });

  it("does not retain a successful revision whose verified bytes exceed the cycle cache budget", async () => {
    const { revision } = await attachmentFixture(testDb.db, privateRoot);
    const cache = createMailAttachmentCache({ maxRetainedBytes: payload.byteLength - 1 });

    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot, cache))
      .resolves.toEqual([expect.objectContaining({ bytes: payload })]);
    expect(cache.size).toBe(0);
  });

  it("rejects an overlong legacy attachment display name before reading its file", async () => {
    const { revision, absolutePath } = await attachmentFixture(testDb.db, privateRoot);
    await testDb.db.onboardingMailRevisionAttachment.updateMany({
      where: { revisionId: revision.id },
      data: { displayName: "附".repeat(241) },
    });
    await unlink(absolutePath);

    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot))
      .rejects.toThrow("附件名称");
  });

  it("rejects more than 100 frozen attachments before reading their files", async () => {
    const { revision, asset, absolutePath } = await attachmentFixture(testDb.db, privateRoot);
    await testDb.db.onboardingMailRevisionAttachment.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        revisionId: revision.id,
        role: OnboardingMailAttachmentRole.ATTACHMENT,
        fileAssetId: asset.id,
        displayName: `附件-${index}.txt`,
        sortOrder: index + 2,
      })),
    });
    await unlink(absolutePath);

    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot))
      .rejects.toThrow("附件数量");
  });

  it("rejects an invalid legacy inline Content-ID before reading its file", async () => {
    const { revision, absolutePath } = await attachmentFixture(testDb.db, privateRoot);
    await testDb.db.onboardingMailRevisionAttachment.updateMany({
      where: { revisionId: revision.id },
      data: {
        role: OnboardingMailAttachmentRole.INLINE_BODY,
        contentId: "x".repeat(128),
      },
    });
    await unlink(absolutePath);

    await expect(loadVerifiedRevisionAttachments(testDb.db, revision.id, privateRoot))
      .rejects.toThrow("Content-ID");
  });

  it("keeps cache accounting idempotent when the same pending revision is retained twice", async () => {
    const cache = createMailAttachmentCache({ maxRetainedBytes: 10 });
    const attachments = [{ fileName: "same.bin", mimeType: "application/octet-stream", bytes: Buffer.alloc(6) }];
    const pending = Promise.resolve(attachments);
    cache.setPending("same", pending);

    cache.retain("same", pending, attachments);
    cache.retain("same", pending, attachments);
    const otherAttachments = [{ fileName: "other.bin", mimeType: "application/octet-stream", bytes: Buffer.alloc(4) }];
    const otherPending = Promise.resolve(otherAttachments);
    cache.setPending("other", otherPending);
    cache.retain("other", otherPending, otherAttachments);

    expect(cache.size).toBe(2);
    expect(cache.get("same")).toBe(pending);
    expect(cache.get("other")).toBe(otherPending);
  });

  it("stages persisted-asset verification below private storage without consulting the global OS temp directory", async () => {
    const storageKey = "onboarding/mail-assets/direct.txt";
    const absolutePath = path.join(privateRoot, storageKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, payload);
    const osTempBlocker = path.join(privateRoot, "not-a-directory");
    await writeFile(osTempBlocker, "blocked");
    vi.stubEnv("TMPDIR", osTempBlocker);

    await expect(verifyPersistedMailAsset({
      storageKey,
      originalName: "direct.txt",
      mimeType: "text/plain",
      sizeBytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    }, { role: OnboardingMailAttachmentRole.ATTACHMENT }, { privateRoot }))
      .resolves.toEqual(payload);

    expect(await readdir(path.join(privateRoot, "tmp/mail-validation"))).toEqual([]);
  });
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { City, FileAssetKind, PortalViewport, Role, UserSource } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { hashPassword } from "@/features/auth/password";
import {
  copyDesktopDraftToMobile,
  deletePortalAsset,
  getPortalDraft,
  getPublishedPortal,
  publishPortal,
  restorePreviousPublication,
  savePortalDraft,
  uploadPortalAsset,
} from "@/features/portal/portal-service";
import { PORTAL_CANVAS_SIZES, portalElementSchema } from "@/features/portal/portal-schemas";
import { createPrismaClient } from "@/lib/db/create-client";
import { createTestDatabase } from "../helpers/test-db";
import { validPng } from "../fixtures/portal-images";

describe("portal service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let actorId: string;
  let assetId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-portal-"));
    const passwordHash = await hashPassword("PortalPass123");
    const actor = await testDb.db.user.create({
      data: { employeeNo: "PORTAL-ADMIN", name: "门户管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash },
    });
    actorId = actor.id;
    assetId = (await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: "portal/test.png",
        originalName: "test.png",
        mimeType: "image/png",
        sizeBytes: 9,
        sha256: "fixture",
        uploadedById: actor.id,
        uploadedBySnapshot: snapshotUserIdentity(actor),
      },
    })).id;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const element = (id = "hero", asset = assetId) => ({
    id,
    kind: "IMAGE" as const,
    assetId: asset,
    x: 0,
    y: 0,
    width: 240,
    height: 120,
    zIndex: 1,
    altText: "办公环境",
  });

  it("validates the safe portal element contract", () => {
    expect(portalElementSchema.safeParse(element()).success).toBe(true);
    expect(portalElementSchema.safeParse({ ...element(), width: 23 }).success).toBe(false);
    expect(portalElementSchema.safeParse({ ...element(), kind: "HTML", html: "<script/>" }).success).toBe(false);
    expect(portalElementSchema.safeParse({ ...element(), assetId: "x".repeat(192) }).success).toBe(false);
    expect(portalElementSchema.safeParse({ ...element(), zIndex: 10_001 }).success).toBe(false);
  });

  it("keeps all eight city and viewport sentinel drafts isolated", async () => {
    for (const city of Object.values(City)) for (const viewport of Object.values(PortalViewport)) {
      await savePortalDraft(testDb.db, city, viewport, [element(`${city}-${viewport}`)], actorId);
    }
    for (const city of Object.values(City)) for (const viewport of Object.values(PortalViewport)) {
      const draft = await getPortalDraft(testDb.db, city, viewport);
      expect(draft?.elements.map((item) => item.id)).toEqual([`${city}-${viewport}`]);
    }
  });

  it("keeps desktop and mobile drafts independent and clamps every save", async () => {
    const desktop = await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [
      { ...element(), x: -50, y: 890, width: 2_000, height: 10 },
    ], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [
      { ...element("mobile"), x: 370, y: -2, width: 200, height: 900 },
    ], actorId);

    expect(desktop).toMatchObject(PORTAL_CANVAS_SIZES.DESKTOP);
    expect(desktop.elements[0]).toMatchObject({ x: 0, y: 876, width: 1440, height: 24 });
    const mobile = await getPortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE);
    expect(mobile?.elements[0]).toMatchObject({ id: "mobile", x: 190, y: 0, width: 200, height: 844 });
    expect((await getPortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP))?.elements[0]?.id).toBe("hero");
  });

  it("rejects missing and non-portal asset references", async () => {
    const guideAsset = await testDb.db.fileAsset.create({ data: {
      kind: FileAssetKind.GUIDE_IMAGE, storageKey: "guides/wrong.png", originalName: "wrong.png", mimeType: "image/png", sizeBytes: 9,
      sha256: "wrong", uploadedById: actorId, uploadedBySnapshot: {},
    } });
    await expect(savePortalDraft(testDb.db, City.XIAN, PortalViewport.DESKTOP, [element("missing", "missing")], actorId)).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
    await expect(savePortalDraft(testDb.db, City.XIAN, PortalViewport.DESKTOP, [element("wrong", guideAsset.id)], actorId)).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });

  it("copies desktop to a detached, clamped mobile draft", async () => {
    await savePortalDraft(testDb.db, City.SHENZHEN, PortalViewport.DESKTOP, [{ ...element(), x: 1300, y: 820, width: 300, height: 200 }], actorId);
    const copied = await copyDesktopDraftToMobile(testDb.db, City.SHENZHEN, actorId);
    expect(copied.elements[0]).toMatchObject({ x: 90, y: 644, width: 300, height: 200 });
    await savePortalDraft(testDb.db, City.SHENZHEN, PortalViewport.DESKTOP, [element("changed")], actorId);
    expect((await getPortalDraft(testDb.db, City.SHENZHEN, PortalViewport.MOBILE))?.elements[0]?.id).toBe("hero");
  });

  it("publishes both viewport drafts atomically as immutable versions and reads latest only", async () => {
    await savePortalDraft(testDb.db, City.CHANGSHA, PortalViewport.DESKTOP, [element("desktop-v1")], actorId);
    await expect(publishPortal(testDb.db, City.CHANGSHA, actorId)).rejects.toMatchObject({ code: "DRAFT_INCOMPLETE" });
    expect(await testDb.db.guidePortalPublication.count()).toBe(0);

    await savePortalDraft(testDb.db, City.CHANGSHA, PortalViewport.MOBILE, [element("mobile-v1")], actorId);
    const first = await publishPortal(testDb.db, City.CHANGSHA, actorId);
    await savePortalDraft(testDb.db, City.CHANGSHA, PortalViewport.DESKTOP, [element("desktop-v2")], actorId);
    await savePortalDraft(testDb.db, City.CHANGSHA, PortalViewport.MOBILE, [element("mobile-v2")], actorId);
    const second = await publishPortal(testDb.db, City.CHANGSHA, actorId);

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const publishedDesktop = await getPublishedPortal(testDb.db, City.CHANGSHA, PortalViewport.DESKTOP);
    expect(publishedDesktop?.sceneVersion).toBe(0);
    expect(publishedDesktop?.sceneVersion === 0 ? publishedDesktop.elements[0]?.id : undefined).toBe("desktop-v2");
    const persistedFirst = await testDb.db.guidePortalPublication.findUniqueOrThrow({
      where: { city_viewport_version: { city: City.CHANGSHA, viewport: PortalViewport.DESKTOP, version: 1 } },
    });
    expect(JSON.stringify(persistedFirst.elements)).toContain("desktop-v1");
  });

  it("serializes concurrent publishing into distinct complete versions", async () => {
    await savePortalDraft(testDb.db, City.XIAN, PortalViewport.DESKTOP, [element("desktop")], actorId);
    await savePortalDraft(testDb.db, City.XIAN, PortalViewport.MOBILE, [element("mobile")], actorId);
    const results = await Promise.all([
      publishPortal(testDb.db, City.XIAN, actorId),
      publishPortal(testDb.db, City.XIAN, actorId),
    ]);
    expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.XIAN } })).toBe(4);
  });

  it("allocates complete versions 1 and 2 across two Prisma clients", async () => {
    const second = createPrismaClient(testDb.databaseUrl);
    try {
      await savePortalDraft(testDb.db, City.XIAN, PortalViewport.DESKTOP, [element("desktop")], actorId);
      await savePortalDraft(testDb.db, City.XIAN, PortalViewport.MOBILE, [element("mobile")], actorId);
      const results = await Promise.all([publishPortal(testDb.db, City.XIAN, actorId), publishPortal(second, City.XIAN, actorId)]);
      expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
      expect(await testDb.db.guidePortalPublication.count({ where: { city: City.XIAN } })).toBe(4);
    } finally { await second.$disconnect(); }
  });

  it("rolls back both viewports and audit when failure is injected after the first publication or audit", async () => {
    await savePortalDraft(testDb.db, City.SHENZHEN, PortalViewport.DESKTOP, [element("desktop")], actorId);
    await savePortalDraft(testDb.db, City.SHENZHEN, PortalViewport.MOBILE, [element("mobile")], actorId);
    const publishWithHooks = publishPortal as unknown as (
      db: PrismaClient, city: City, actorId: string,
      hooks: { afterFirstPublication?: () => void; afterAudit?: () => void },
    ) => Promise<unknown>;
    await expect(publishWithHooks(testDb.db, City.SHENZHEN, actorId, { afterFirstPublication: () => { throw new Error("after-first"); } })).rejects.toThrow("after-first");
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.SHENZHEN } })).toBe(0);
    expect(await testDb.db.auditLog.count({ where: { action: "PORTAL_PUBLISH" } })).toBe(0);
    await expect(publishWithHooks(testDb.db, City.SHENZHEN, actorId, { afterAudit: () => { throw new Error("after-audit"); } })).rejects.toThrow("after-audit");
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.SHENZHEN } })).toBe(0);
    expect(await testDb.db.auditLog.count({ where: { action: "PORTAL_PUBLISH" } })).toBe(0);
  });

  it("restores a previous immutable publication into only the selected draft", async () => {
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [element("desktop-v1")], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [element("mobile-v1")], actorId);
    await publishPortal(testDb.db, City.SHANGHAI, actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [element("desktop-v2")], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [element("mobile-v2")], actorId);
    await publishPortal(testDb.db, City.SHANGHAI, actorId);

    const restored = await restorePreviousPublication(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, actorId);
    expect(restored.elements[0]?.id).toBe("desktop-v1");
    expect((await getPortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE))?.elements[0]?.id).toBe("mobile-v2");
    const publishedDesktop = await getPublishedPortal(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP);
    expect(publishedDesktop?.sceneVersion).toBe(0);
    expect(publishedDesktop?.sceneVersion === 0 ? publishedDesktop.elements[0]?.id : undefined).toBe("desktop-v2");
    const restoreAudit = await testDb.db.auditLog.findFirstOrThrow({ where: { action: "PORTAL_PUBLICATION_RESTORE" } });
    expect(restoreAudit.actorSnapshot).toMatchObject({ id: actorId, employeeNo: "PORTAL-ADMIN" });
    expect(restoreAudit.metadata).toMatchObject({ city: City.SHANGHAI, viewport: PortalViewport.DESKTOP, sourceVersion: 1 });
  });

  it("refuses to call the only publication a previous version", async () => {
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [element("desktop-v1")], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [element("mobile-v1")], actorId);
    await publishPortal(testDb.db, City.SHANGHAI, actorId);
    await expect(restorePreviousPublication(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, actorId)).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });

  it("records copy as its own atomic audit with safe source metadata", async () => {
    await savePortalDraft(testDb.db, City.CHANGSHA, PortalViewport.DESKTOP, [element("copy-source")], actorId);
    await copyDesktopDraftToMobile(testDb.db, City.CHANGSHA, actorId);
    const audit = await testDb.db.auditLog.findFirstOrThrow({ where: { action: "PORTAL_DRAFT_COPY" } });
    expect(audit.actorSnapshot).toMatchObject({ id: actorId, employeeNo: "PORTAL-ADMIN" });
    expect(audit.metadata).toMatchObject({ city: City.CHANGSHA, sourceViewport: "DESKTOP", targetViewport: "MOBILE" });
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("prevents a two-client delete-first barrier race from committing a dangling draft reference", async () => {
    const second = createPrismaClient(testDb.databaseUrl);
    await mkdir(path.join(privateRoot, "portal"), { recursive: true });
    await writeFile(path.join(privateRoot, "portal", "test.png"), validPng());
    const ready = deferred(); const release = deferred();
    const saving = savePortalDraft(second, City.XIAN, PortalViewport.DESKTOP, [element("raced-draft")], actorId, { beforeSaveTransaction: async () => { ready.resolve(); await release.promise; } });
    await ready.promise;
    const deleting = deletePortalAsset(testDb.db, assetId, actorId, privateRoot);
    await deleting;
    release.resolve();
    const [deleteResult, saveResult] = await Promise.allSettled([deleting, saving]);
    expect(deleteResult.status).toBe("fulfilled");
    expect(saveResult.status).toBe("rejected");
    expect(await testDb.db.guidePortalDraft.count({ where: { city: City.XIAN } })).toBe(0);
    await second.$disconnect();
  });

  it("prevents a two-client save-wins barrier race from deleting the newly referenced asset", async () => {
    const second = createPrismaClient(testDb.databaseUrl);
    const ready = deferred(); const release = deferred();
    const deleting = deletePortalAsset(testDb.db, assetId, actorId, privateRoot, { beforeDeleteTransaction: async () => { ready.resolve(); await release.promise; } });
    await ready.promise;
    const saving = savePortalDraft(second, City.XIAN, PortalViewport.DESKTOP, [element("raced-draft")], actorId);
    await saving;
    release.resolve();
    const [saveResult, deleteResult] = await Promise.allSettled([saving, deleting]);
    expect(saveResult.status).toBe("fulfilled");
    expect(deleteResult.status).toBe("rejected");
    expect(await testDb.db.fileAsset.findUnique({ where: { id: assetId } })).not.toBeNull();
    expect(await testDb.db.guidePortalAssetReference.count({ where: { assetId } })).toBe(1);
    await second.$disconnect();
  });

  it("prevents deletion while a second client publishes referenced drafts", async () => {
    const second = createPrismaClient(testDb.databaseUrl);
    await savePortalDraft(second, City.XIAN, PortalViewport.DESKTOP, [element("desktop")], actorId);
    await savePortalDraft(second, City.XIAN, PortalViewport.MOBILE, [element("mobile")], actorId);
    const [published, deleted] = await Promise.allSettled([publishPortal(second, City.XIAN, actorId), deletePortalAsset(testDb.db, assetId, actorId, privateRoot)]);
    expect(published.status).toBe("fulfilled");
    expect(deleted.status).toBe("rejected");
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.XIAN } })).toBe(2);
    expect(await testDb.db.fileAsset.findUnique({ where: { id: assetId } })).not.toBeNull();
    await second.$disconnect();
  });

  it("stores uploads under a random safe key and protects all referenced assets from deletion", async () => {
    const png = validPng();
    const uploaded = await uploadPortalAsset(testDb.db, {
      fileName: "../display-name.png", mimeType: "image/png", bytes: png,
    }, actorId, privateRoot);
    expect(uploaded).not.toHaveProperty("storageKey");
    expect(uploaded.originalName).toBe("display-name.png");
    const stored = await testDb.db.fileAsset.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(stored.storageKey).toMatch(/^portal\/[0-9a-f-]+\.png$/);
    expect(path.resolve(privateRoot, stored.storageKey).startsWith(path.resolve(privateRoot) + path.sep)).toBe(true);
    expect(await readFile(path.resolve(privateRoot, stored.storageKey))).toEqual(Buffer.from(png));

    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [element("uploaded", uploaded.id)], actorId);
    await expect(deletePortalAsset(testDb.db, uploaded.id, actorId, privateRoot)).rejects.toMatchObject({ code: "ASSET_REFERENCED" });
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [], actorId);
    await deletePortalAsset(testDb.db, uploaded.id, actorId, privateRoot);
    expect(await testDb.db.fileAsset.findUnique({ where: { id: uploaded.id } })).toBeNull();

    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [element()], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [element("mobile")], actorId);
    await publishPortal(testDb.db, City.SHANGHAI, actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP, [], actorId);
    await savePortalDraft(testDb.db, City.SHANGHAI, PortalViewport.MOBILE, [], actorId);
    await expect(deletePortalAsset(testDb.db, assetId, actorId, privateRoot)).rejects.toMatchObject({ code: "ASSET_REFERENCED" });
  });

  it("cleans an exclusive upload file after failure and reports cleanup failure explicitly", async () => {
    const failure = new Error("injected-after-file-write");
    await expect(uploadPortalAsset(testDb.db, {
      fileName: "cleanup.png", mimeType: "image/png", bytes: validPng(),
    }, actorId, privateRoot, { afterAssetFileWrite: () => { throw failure; } })).rejects.toBe(failure);
    expect(await readdir(path.join(privateRoot, "portal"))).toEqual([]);

    await expect(uploadPortalAsset(testDb.db, {
      fileName: "cleanup-fails.png", mimeType: "image/png", bytes: validPng(),
    }, actorId, privateRoot, { afterAssetFileWrite: async (absolutePath) => {
      await rm(absolutePath);
      await mkdir(absolutePath);
      throw failure;
    } })).rejects.toMatchObject({ code: "ASSET_CLEANUP_FAILED" });
  });
});

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { City, FileAssetKind, PortalViewport, Role, UserSource } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { hashPassword } from "@/features/auth/password";
import {
  assertSceneBitmapBudget,
  extractSceneAssetReferences,
} from "@/features/portal/portal-asset-references";
import { elementBounds } from "@/features/portal/portal-geometry";
import type { PortalSceneV1 } from "@/features/portal/portal-scene";
import {
  confirmMobileSceneReview,
  copyDesktopSceneToMobile,
  deletePortalAsset,
  getPortalDraft,
  getPublishedPortal,
  listPortalAssets,
  listPortalHistory,
  publishPortal,
  publishPortalScenes,
  restorePortalPublication,
  savePortalDraft,
  savePortalSceneDraft,
  uploadPortalAsset,
} from "@/features/portal/portal-service";
import { createPrismaClient } from "@/lib/db/create-client";
import { createTestDatabase } from "../helpers/test-db";
import { validPng } from "../fixtures/portal-images";

describe("portal V1 service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let actorId: string;
  let assetId: string;
  let backgroundAssetId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-portal-v1-"));
    const actor = await testDb.db.user.create({
      data: {
        employeeNo: "PORTAL-V1-ADMIN",
        name: "V1 门户管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("PortalPass123"),
      },
    });
    actorId = actor.id;

    async function inspectedAsset(name: string, decodedCostBytes: bigint) {
      return testDb.db.fileAsset.create({
        data: {
          kind: FileAssetKind.PORTAL_IMAGE,
          storageKey: `portal/${name}.png`,
          originalName: `${name}.png`,
          mimeType: "image/png",
          sizeBytes: 9,
          sha256: name,
          uploadedById: actor.id,
          uploadedBySnapshot: snapshotUserIdentity(actor),
          portalAssetMetadata: {
            create: {
              category: "IMAGE",
              width: 100,
              height: 100,
              frameCount: 1,
              decodedCostBytes,
              inspectionStatus: "VALID",
              inspectedAt: new Date(),
            },
          },
        },
      });
    }

    assetId = (await inspectedAsset("foreground", 40_000n)).id;
    backgroundAssetId = (await inspectedAsset("background", 40_000n)).id;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  function imageElement(id: string, asset = assetId) {
    return {
      id,
      name: id,
      type: "IMAGE" as const,
      assetId: asset,
      altText: id,
      fitMode: "CONTAIN" as const,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      cornerRadius: 0,
      action: null,
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      hidden: false,
    };
  }

  function scene(
    viewport: "DESKTOP" | "MOBILE",
    options: {
      id?: string;
      asset?: string;
      background?: string | null;
      requiresMobileReview?: boolean;
      hidden?: boolean;
    } = {},
  ): PortalSceneV1 {
    return {
      sceneVersion: 1,
      viewport,
      requiresMobileReview: options.requiresMobileReview ?? false,
      background: {
        assetId: options.background ?? null,
        fitMode: "COVER",
        positionX: 50,
        positionY: 50,
        backgroundColor: "#FFFFFF",
        locked: false,
      },
      elements: options.id === undefined
        ? []
        : [{ ...imageElement(options.id, options.asset), hidden: options.hidden ?? false }],
    };
  }

  it("extracts the background and de-duplicates repeated asset/element pairs", () => {
    const input = scene("DESKTOP", { id: "hero", background: backgroundAssetId });
    input.elements.push({ ...imageElement("hero"), zIndex: 1 });

    expect(extractSceneAssetReferences(input)).toEqual([
      { assetId: backgroundAssetId, elementId: "__background__" },
      { assetId, elementId: "hero" },
    ]);

    expect(() => extractSceneAssetReferences(scene("DESKTOP", {
      id: "__background__",
      background: backgroundAssetId,
    }))).toThrowError(expect.objectContaining({ code: "INVALID_ASSET_REFERENCE" }));
  });

  it("enforces a 256 MiB unique decoded bitmap budget and quarantines legacy assets", async () => {
    const exact = await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: "portal/exact.png",
        originalName: "exact.png",
        mimeType: "image/png",
        sizeBytes: 9,
        sha256: "exact",
        uploadedById: actorId,
        uploadedBySnapshot: {},
        portalAssetMetadata: {
          create: {
            category: "IMAGE",
            width: 8_192,
            height: 8_192,
            frameCount: 1,
            decodedCostBytes: 268_435_456n,
            inspectionStatus: "VALID",
            inspectedAt: new Date(),
          },
        },
      },
    });
    await expect(assertSceneBitmapBudget(testDb.db, scene("DESKTOP", { id: "one", asset: exact.id }))).resolves.toBe(268_435_456);

    const extra = scene("DESKTOP", { id: "one", asset: exact.id, background: backgroundAssetId });
    await expect(assertSceneBitmapBudget(testDb.db, extra)).rejects.toMatchObject({ code: "SCENE_BITMAP_BUDGET_EXCEEDED" });

    const animated = await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: "portal/animated.png",
        originalName: "animated.png",
        mimeType: "image/png",
        sizeBytes: 9,
        sha256: "animated",
        uploadedById: actorId,
        uploadedBySnapshot: {},
        portalAssetMetadata: {
          create: {
            category: "IMAGE",
            width: 8_192,
            height: 4_096,
            frameCount: 2,
            decodedCostBytes: 268_435_456n,
            inspectionStatus: "VALID",
            inspectedAt: new Date(),
          },
        },
      },
    });
    await expect(assertSceneBitmapBudget(testDb.db, scene("DESKTOP", {
      id: "animated",
      asset: animated.id,
      background: backgroundAssetId,
    }))).resolves.toBe(134_257_728);

    const legacy = await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: "portal/legacy.png",
        originalName: "legacy.png",
        mimeType: "image/png",
        sizeBytes: 9,
        sha256: "legacy",
        uploadedById: actorId,
        uploadedBySnapshot: {},
        portalAssetMetadata: {
          create: {
            category: "IMAGE",
            inspectionStatus: "LEGACY_UNINSPECTED",
            incompatibilityReason: "migration quarantine",
          },
        },
      },
    });
    await expect(savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "legacy", asset: legacy.id }),
      0,
      actorId,
    )).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });

  it("returns a conflict for a stale draft revision without overwriting scene or references", async () => {
    const first = await savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "first", background: backgroundAssetId }),
      0,
      actorId,
    );
    expect(first).toMatchObject({
      revision: 1,
      scene: { viewport: "DESKTOP", elements: [{ id: "first" }] },
      updatedBySnapshot: { id: actorId, employeeNo: "PORTAL-V1-ADMIN" },
    });

    await expect(savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "stale" }),
      0,
      actorId,
    )).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    const stored = await testDb.db.guidePortalDraft.findUniqueOrThrow({
      where: { city_viewport: { city: City.SHANGHAI, viewport: PortalViewport.DESKTOP } },
    });
    expect(stored.draftRevision).toBe(1);
    expect(stored.scene).toMatchObject({ elements: [{ id: "first" }] });
    expect(await testDb.db.guidePortalAssetReference.findMany({
      where: { draftId: stored.id },
      select: { assetId: true, elementId: true },
      orderBy: { elementId: "asc" },
    })).toEqual([
      { assetId: backgroundAssetId, elementId: "__background__" },
      { assetId, elementId: "first" },
    ]);
    expect(await testDb.db.auditLog.count({ where: { action: "PORTAL_DRAFT_SAVE" } })).toBe(1);

    const dualRead = await getPortalDraft(testDb.db, City.SHANGHAI, PortalViewport.DESKTOP);
    expect(dualRead).toMatchObject({
      revision: 1,
      scene: { sceneVersion: 1, viewport: "DESKTOP", elements: [{ id: "first" }] },
      elements: [{ id: "first" }],
    });
  });

  it("copies centers proportionally, requires review, and confirms review with a revision check", async () => {
    const desktop = scene("DESKTOP");
    desktop.elements = [
      {
        id: "welcome",
        name: "欢迎",
        type: "TEXT",
        text: "欢迎加入",
        color: "#123456",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 18,
        fontWeight: 400,
        lineHeight: 1,
        align: "CENTER",
        italic: true,
        underline: true,
        letterSpacing: 9,
        backgroundColor: "#F0F9FF",
        action: { href: "/welcome", target: "_self" },
        x: 620,
        y: 390,
        width: 200,
        height: 120,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        hidden: false,
      },
      {
        id: "shadowed-shape",
        name: "阴影矩形",
        type: "RECT",
        fillEnabled: true,
        fill: "#FFFFFF",
        lastFillColor: "#FFFFFF",
        stroke: "#112233",
        strokeWidth: 8,
        dash: "DASHED",
        shadow: { color: "#000000", opacity: 0.3, blur: 18, offsetX: 12, offsetY: 9 },
        x: 100,
        y: 100,
        width: 300,
        height: 160,
        rotation: 0,
        opacity: 1,
        zIndex: 1,
        locked: false,
        hidden: false,
      },
      {
        id: "bordered-button",
        name: "有边框按钮",
        type: "BUTTON",
        text: "查看",
        backgroundColor: "#112233",
        cornerRadius: 24,
        action: { href: "/", target: "_self" },
        color: "#FFFFFF",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 18,
        fontWeight: 600,
        lineHeight: 1.2,
        align: "CENTER",
        border: { color: "#FFFFFF", width: 6, dash: "DOTTED" },
        shadow: { color: "#000000", opacity: 0.4, blur: 15, offsetX: -6, offsetY: 9 },
        x: 500,
        y: 100,
        width: 240,
        height: 80,
        rotation: 0,
        opacity: 1,
        zIndex: 2,
        locked: false,
        hidden: false,
      },
    ];
    const saved = await savePortalSceneDraft(testDb.db, City.SHENZHEN, PortalViewport.DESKTOP, desktop, 0, actorId);
    const copied = await copyDesktopSceneToMobile(testDb.db, City.SHENZHEN, saved.revision, 0, actorId);
    expect(copied.revision).toBe(1);
    expect(copied.scene.requiresMobileReview).toBe(true);
    expect(copied.scene.elements[0]).toMatchObject({
      type: "TEXT",
      fontSize: 14,
      italic: true,
      underline: true,
      letterSpacing: 9 * 390 / 1_440,
      backgroundColor: "#F0F9FF",
      action: { href: "/welcome", target: "_self" },
    });
    const copiedElement = copied.scene.elements[0]!;
    expect(copiedElement.x + copiedElement.width / 2).toBeCloseTo(195, 5);
    expect(copiedElement.y + copiedElement.height / 2).toBeCloseTo(422, 5);
    expect(copied.scene.elements.find(({ id }) => id === "shadowed-shape")).toMatchObject({
      dash: "DASHED",
      strokeWidth: 8 * 390 / 1_440,
      shadow: {
        blur: 18 * 390 / 1_440,
        offsetX: 12 * 390 / 1_440,
        offsetY: 9 * 390 / 1_440,
      },
    });
    expect(copied.scene.elements.find(({ id }) => id === "bordered-button")).toMatchObject({
      cornerRadius: 24 * 390 / 1_440,
      border: { width: 6 * 390 / 1_440, dash: "DOTTED" },
      shadow: {
        blur: 15 * 390 / 1_440,
        offsetX: -6 * 390 / 1_440,
        offsetY: 9 * 390 / 1_440,
      },
    });

    await expect(confirmMobileSceneReview(testDb.db, City.SHENZHEN, 0, actorId))
      .rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    const confirmed = await confirmMobileSceneReview(testDb.db, City.SHENZHEN, copied.revision, actorId);
    expect(confirmed).toMatchObject({ revision: 2, scene: { requiresMobileReview: false } });
  });

  it("preserves the mobile review gate across ordinary saves until explicit confirmation", async () => {
    const desktop = await savePortalSceneDraft(
      testDb.db,
      City.SHENZHEN,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "desktop" }),
      0,
      actorId,
    );
    const copied = await copyDesktopSceneToMobile(
      testDb.db,
      City.SHENZHEN,
      desktop.revision,
      0,
      actorId,
    );
    const maliciousSave = await savePortalSceneDraft(
      testDb.db,
      City.SHENZHEN,
      PortalViewport.MOBILE,
      { ...copied.scene, requiresMobileReview: false },
      copied.revision,
      actorId,
    );
    expect(maliciousSave.scene.requiresMobileReview).toBe(true);
    await expect(publishPortalScenes(testDb.db, City.SHENZHEN, {
      desktop: desktop.revision,
      mobile: maliciousSave.revision,
    }, actorId)).rejects.toMatchObject({ code: "MOBILE_REVIEW_REQUIRED" });

    const confirmed = await confirmMobileSceneReview(
      testDb.db,
      City.SHENZHEN,
      maliciousSave.revision,
      actorId,
    );
    await expect(publishPortalScenes(testDb.db, City.SHENZHEN, {
      desktop: desktop.revision,
      mobile: confirmed.revision,
    }, actorId)).resolves.toMatchObject({ version: 1 });
    expect(await testDb.db.auditLog.count({
      where: { action: "PORTAL_MOBILE_REVIEW_CONFIRM", targetId: copied.id },
    })).toBe(1);
  });

  it("persists auto-height canvas dimensions and scales long-canvas elements when copying to mobile", async () => {
    const longBackground = await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: "portal/long-background.png",
        originalName: "上海工位.PNG",
        mimeType: "image/png",
        sizeBytes: 9,
        sha256: "long-background",
        uploadedById: actorId,
        uploadedBySnapshot: {},
        portalAssetMetadata: {
          create: {
            category: "BACKGROUND",
            width: 1_625,
            height: 6_375,
            frameCount: 1,
            decodedCostBytes: 41_437_500n,
            inspectionStatus: "VALID",
            inspectedAt: new Date(),
          },
        },
      },
    });
    const desktopScene: PortalSceneV1 = {
      ...scene("DESKTOP", { id: "floor-plan-marker" }),
      background: {
        assetId: longBackground.id,
        fitMode: "AUTO_HEIGHT",
        naturalWidth: 1_625,
        naturalHeight: 6_375,
        positionX: 50,
        positionY: 50,
        backgroundColor: "#FFFFFF",
        locked: false,
      },
      elements: [{ ...imageElement("floor-plan-marker"), x: 720, y: 5_000 }],
    };

    const desktopHeight = 1_440 * 6_375 / 1_625;
    const mobileHeight = 390 * 6_375 / 1_625;
    const saved = await savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      desktopScene,
      0,
      actorId,
    );

    expect(saved.canvasWidth).toBe(1_440);
    expect(saved.canvasHeight).toBeCloseTo(desktopHeight, 8);
    expect(saved.scene.canvas?.logicalWidth).toBe(1_440);
    expect(saved.scene.canvas?.logicalHeight).toBeCloseTo(desktopHeight, 8);
    expect(await testDb.db.guidePortalDraft.findUniqueOrThrow({
      where: { city_viewport: { city: City.SHANGHAI, viewport: PortalViewport.DESKTOP } },
      select: { canvasWidth: true, canvasHeight: true },
    })).toEqual({ canvasWidth: 1_440, canvasHeight: Math.round(desktopHeight) });

    const copied = await copyDesktopSceneToMobile(
      testDb.db,
      City.SHANGHAI,
      saved.revision,
      0,
      actorId,
    );
    expect(copied.canvasWidth).toBe(390);
    expect(copied.canvasHeight).toBeCloseTo(mobileHeight, 8);
    expect(copied.scene.background).toMatchObject({
      fitMode: "AUTO_HEIGHT",
      naturalWidth: 1_625,
      naturalHeight: 6_375,
    });
    const marker = copied.scene.elements[0]!;
    expect(marker.x + marker.width / 2).toBeCloseTo((720 + 120) * 390 / 1_440, 8);
    expect(marker.y + marker.height / 2).toBeCloseTo((5_000 + 60) * 390 / 1_440, 8);

    const confirmed = await confirmMobileSceneReview(testDb.db, City.SHANGHAI, copied.revision, actorId);
    const published = await publishPortalScenes(testDb.db, City.SHANGHAI, {
      desktop: saved.revision,
      mobile: confirmed.revision,
    }, actorId);
    const publishedDesktop = published.publications.find(({ viewport }) => viewport === "DESKTOP")!;
    const publishedMobile = published.publications.find(({ viewport }) => viewport === "MOBILE")!;
    expect(publishedDesktop.canvasHeight).toBeCloseTo(desktopHeight, 8);
    expect(publishedMobile.canvasHeight).toBeCloseTo(mobileHeight, 8);
  });

  it("preserves image, icon, and shape aspect ratios when mobile minimums are applied", async () => {
    const desktopScene = scene("DESKTOP");
    desktopScene.elements = [
      {
        ...imageElement("tall-image"),
        x: 100,
        y: 100,
        width: 20,
        height: 200,
        zIndex: 0,
      },
      {
        id: "wide-icon",
        name: "宽图标",
        type: "ICON",
        iconName: "Star",
        color: "#123456",
        action: null,
        x: 200,
        y: 300,
        width: 200,
        height: 20,
        rotation: 0,
        opacity: 1,
        zIndex: 1,
        locked: false,
        hidden: false,
      },
      {
        id: "tall-shape",
        name: "高矩形",
        type: "RECT",
        fillEnabled: true,
        fill: "#123456",
        lastFillColor: "#123456",
        stroke: "#654321",
        strokeWidth: 1,
        dash: "SOLID",
        shadow: null,
        x: 500,
        y: 100,
        width: 20,
        height: 200,
        rotation: 0,
        opacity: 1,
        zIndex: 2,
        locked: false,
        hidden: false,
      },
      {
        ...imageElement("extreme-tall-image"),
        x: 900,
        y: 0,
        width: 1,
        height: 900,
        zIndex: 3,
      },
      {
        id: "extreme-wide-icon",
        name: "极宽图标",
        type: "ICON",
        iconName: "Star",
        color: "#123456",
        action: null,
        x: 0,
        y: 850,
        width: 1_440,
        height: 1,
        rotation: 0,
        opacity: 1,
        zIndex: 4,
        locked: false,
        hidden: false,
      },
      {
        ...imageElement("rotated-extreme-image"),
        x: 700,
        y: 0,
        width: 1,
        height: 900,
        rotation: 45,
        zIndex: 5,
      },
      {
        id: "rotated-extreme-shape",
        name: "旋转极限描边矩形",
        type: "RECT",
        fillEnabled: true,
        fill: "#123456",
        lastFillColor: "#123456",
        stroke: "#654321",
        strokeWidth: 100,
        dash: "SOLID",
        shadow: null,
        x: 700,
        y: 0,
        width: 1,
        height: 900,
        rotation: 45,
        opacity: 1,
        zIndex: 6,
        locked: false,
        hidden: false,
      },
    ];
    const desktop = await savePortalSceneDraft(
      testDb.db,
      City.XIAN,
      PortalViewport.DESKTOP,
      desktopScene,
      0,
      actorId,
    );
    const mobile = await copyDesktopSceneToMobile(
      testDb.db,
      City.XIAN,
      desktop.revision,
      0,
      actorId,
    );

    const byId = new Map(mobile.scene.elements.map((element) => [element.id, element]));
    expect(byId.get("tall-image")!.width / byId.get("tall-image")!.height).toBeCloseTo(0.1, 8);
    expect(byId.get("wide-icon")!.width / byId.get("wide-icon")!.height).toBeCloseTo(10, 8);
    expect(byId.get("tall-shape")!.width / byId.get("tall-shape")!.height).toBeCloseTo(0.1, 8);
    // Ratios beyond what a 390x844 canvas can represent with the domain's
    // one-pixel floor are explicitly capped at that representable boundary.
    expect(byId.get("extreme-tall-image")!.width / byId.get("extreme-tall-image")!.height)
      .toBeCloseTo(1 / 844, 8);
    expect(byId.get("extreme-wide-icon")!.width / byId.get("extreme-wide-icon")!.height)
      .toBeCloseTo(390, 8);
    const fortyFiveDegrees = Math.PI / 4;
    const rotatedMinimumAspect = Math.max(
      Math.sin(fortyFiveDegrees) / (390 - Math.cos(fortyFiveDegrees)),
      Math.cos(fortyFiveDegrees) / (844 - Math.sin(fortyFiveDegrees)),
    );
    expect(
      byId.get("rotated-extreme-image")!.width
      / byId.get("rotated-extreme-image")!.height,
    ).toBeCloseTo(rotatedMinimumAspect, 8);
    const rotatedShape = byId.get("rotated-extreme-shape")!;
    expect(rotatedShape.width / rotatedShape.height).toBeGreaterThan(rotatedMinimumAspect);
    const rotatedShapeBounds = elementBounds(rotatedShape);
    expect(rotatedShapeBounds.x).toBeGreaterThanOrEqual(-1e-9);
    expect(rotatedShapeBounds.y).toBeGreaterThanOrEqual(-1e-9);
    expect(rotatedShapeBounds.x + rotatedShapeBounds.width).toBeLessThanOrEqual(390 + 1e-9);
    expect(rotatedShapeBounds.y + rotatedShapeBounds.height).toBeLessThanOrEqual(844 + 1e-9);
    for (const element of byId.values()) {
      expect(element.x).toBeGreaterThanOrEqual(0);
      expect(element.y).toBeGreaterThanOrEqual(0);
      expect(element.x + element.width).toBeLessThanOrEqual(390);
      expect(element.y + element.height).toBeLessThanOrEqual(844);
    }
  });

  it("treats transparent elements and blank text as empty rendered content", async () => {
    const transparent = scene("DESKTOP", { id: "transparent" });
    transparent.elements[0]!.opacity = 0;
    const blankText = scene("MOBILE");
    blankText.elements = [{
      id: "blank",
      name: "空文本",
      type: "TEXT",
      text: "   ",
      color: "#123456",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 18,
      fontWeight: 400,
      lineHeight: 1.2,
      align: "LEFT",
      italic: false,
      underline: false,
      letterSpacing: 0,
      backgroundColor: null,
      action: null,
      x: 20,
      y: 20,
      width: 120,
      height: 44,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      hidden: false,
    }];
    const desktop = await savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      transparent,
      0,
      actorId,
    );
    const mobile = await savePortalSceneDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.MOBILE,
      blankText,
      0,
      actorId,
    );
    await expect(publishPortalScenes(testDb.db, City.SHANGHAI, {
      desktop: desktop.revision,
      mobile: mobile.revision,
    }, actorId)).rejects.toMatchObject({ code: "DRAFT_EMPTY" });
  });

  it("rejects stale, empty, and unreviewed drafts and publishes both viewports atomically", async () => {
    const emptyDesktop = await savePortalSceneDraft(
      testDb.db,
      City.CHANGSHA,
      PortalViewport.DESKTOP,
      scene("DESKTOP"),
      0,
      actorId,
    );
    const mobile = await savePortalSceneDraft(
      testDb.db,
      City.CHANGSHA,
      PortalViewport.MOBILE,
      scene("MOBILE", { id: "mobile", requiresMobileReview: true }),
      0,
      actorId,
    );
    await expect(publishPortalScenes(testDb.db, City.CHANGSHA, {
      desktop: emptyDesktop.revision,
      mobile: mobile.revision,
    }, actorId)).rejects.toMatchObject({ code: "DRAFT_EMPTY" });

    const desktopInput = scene("DESKTOP", { id: "desktop", background: backgroundAssetId });
    desktopInput.elements.push({
      ...imageElement("transparent-legacy"),
      opacity: 0,
      zIndex: 1,
    });
    const desktop = await savePortalSceneDraft(
      testDb.db,
      City.CHANGSHA,
      PortalViewport.DESKTOP,
      desktopInput,
      emptyDesktop.revision,
      actorId,
    );
    await expect(publishPortalScenes(testDb.db, City.CHANGSHA, {
      desktop: desktop.revision,
      mobile: mobile.revision,
    }, actorId)).rejects.toMatchObject({ code: "MOBILE_REVIEW_REQUIRED" });
    const reviewed = await confirmMobileSceneReview(testDb.db, City.CHANGSHA, mobile.revision, actorId);
    await expect(publishPortalScenes(testDb.db, City.CHANGSHA, {
      desktop: desktop.revision - 1,
      mobile: reviewed.revision,
    }, actorId)).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

    const publishWithHooks = publishPortalScenes as unknown as (
      db: PrismaClient,
      city: City,
      revisions: { desktop: number; mobile: number },
      actor: string,
      hooks: { afterFirstPublication?: () => void },
    ) => Promise<unknown>;
    await expect(publishWithHooks(testDb.db, City.CHANGSHA, {
      desktop: desktop.revision,
      mobile: reviewed.revision,
    }, actorId, { afterFirstPublication: () => { throw new Error("paired-rollback"); } }))
      .rejects.toThrow("paired-rollback");
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.CHANGSHA } })).toBe(0);

    const published = await publishPortalScenes(testDb.db, City.CHANGSHA, {
      desktop: desktop.revision,
      mobile: reviewed.revision,
    }, actorId);
    expect(published).toMatchObject({ city: City.CHANGSHA, version: 1 });
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.CHANGSHA } })).toBe(2);
    expect(await testDb.db.guidePortalAssetReference.count({
      where: { publication: { city: City.CHANGSHA, version: 1 } },
    })).toBe(4);
    expect(await testDb.db.auditLog.count({ where: { action: "PORTAL_PUBLISH" } })).toBe(1);
    const persistedDesktop = await testDb.db.guidePortalPublication.findUniqueOrThrow({
      where: {
        city_viewport_version: {
          city: City.CHANGSHA,
          viewport: PortalViewport.DESKTOP,
          version: 1,
        },
      },
    });
    expect(persistedDesktop).toMatchObject({
      sceneVersion: 1,
      scene: {
        sceneVersion: 1,
        viewport: "DESKTOP",
        elements: [{ id: "desktop" }, { id: "transparent-legacy", opacity: 0 }],
      },
      elements: [{
        id: "desktop",
        kind: "IMAGE",
        assetId,
      }],
    });
    expect(Array.isArray(persistedDesktop.elements)).toBe(true);
    expect(await getPublishedPortal(
      testDb.db,
      City.CHANGSHA,
      PortalViewport.DESKTOP,
    )).toMatchObject({
      sceneVersion: 1,
      scene: {
        sceneVersion: 1,
        viewport: "DESKTOP",
        background: { assetId: backgroundAssetId },
        elements: [{ id: "desktop" }, { id: "transparent-legacy", opacity: 0 }],
      },
    });
  });

  // Multi-instance publish: serializePublication is per PrismaClient (in-process).
  // Across clients only unique(city,viewport,version) + P2002/lock retry must allocate 1 then 2.
  it("allocates complete V1 versions 1 and 2 across two Prisma clients", async () => {
    const second = createPrismaClient(testDb.databaseUrl);
    try {
      const desktop = await savePortalSceneDraft(
        testDb.db,
        City.XIAN,
        PortalViewport.DESKTOP,
        scene("DESKTOP", { id: "desktop", background: backgroundAssetId }),
        0,
        actorId,
      );
      const mobile = await savePortalSceneDraft(
        testDb.db,
        City.XIAN,
        PortalViewport.MOBILE,
        scene("MOBILE", { id: "mobile", background: backgroundAssetId }),
        0,
        actorId,
      );
      const revisions = { desktop: desktop.revision, mobile: mobile.revision };
      const results = await Promise.all([
        publishPortalScenes(testDb.db, City.XIAN, revisions, actorId),
        publishPortalScenes(second, City.XIAN, revisions, actorId),
      ]);
      expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
      // Two concurrent publishes × two viewports each.
      expect(await testDb.db.guidePortalPublication.count({ where: { city: City.XIAN } })).toBe(4);
    } finally {
      await second.$disconnect();
    }
  });

  it("keeps native V0 and V1 publication response discriminators distinct", async () => {
    const legacyElement = (id: string) => ({
      id,
      kind: "IMAGE" as const,
      assetId,
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      zIndex: 0,
      altText: id,
    });
    await savePortalDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
      [legacyElement("legacy-desktop")],
      actorId,
    );
    await savePortalDraft(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.MOBILE,
      [legacyElement("legacy-mobile")],
      actorId,
    );
    await publishPortal(testDb.db, City.SHANGHAI, actorId);

    expect(await getPublishedPortal(
      testDb.db,
      City.SHANGHAI,
      PortalViewport.DESKTOP,
    )).toMatchObject({
      sceneVersion: 0,
      viewport: "DESKTOP",
      elements: [{ id: "legacy-desktop" }],
    });
  });

  it("lists only the latest ten paired versions and restores with optimistic revision control", async () => {
    let desktop = await savePortalSceneDraft(
      testDb.db,
      City.XIAN,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "desktop-0" }),
      0,
      actorId,
    );
    let mobile = await savePortalSceneDraft(
      testDb.db,
      City.XIAN,
      PortalViewport.MOBILE,
      scene("MOBILE", { id: "mobile-0" }),
      0,
      actorId,
    );
    for (let version = 1; version <= 12; version += 1) {
      await publishPortalScenes(testDb.db, City.XIAN, {
        desktop: desktop.revision,
        mobile: mobile.revision,
      }, actorId);
      desktop = await savePortalSceneDraft(
        testDb.db,
        City.XIAN,
        PortalViewport.DESKTOP,
        scene("DESKTOP", { id: `desktop-${version}` }),
        desktop.revision,
        actorId,
      );
      mobile = await savePortalSceneDraft(
        testDb.db,
        City.XIAN,
        PortalViewport.MOBILE,
        scene("MOBILE", { id: `mobile-${version}` }),
        mobile.revision,
        actorId,
      );
    }

    const history = await listPortalHistory(testDb.db, City.XIAN);
    expect(history).toHaveLength(10);
    expect(history.map((entry) => entry.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    await expect(restorePortalPublication(
      testDb.db,
      City.XIAN,
      PortalViewport.DESKTOP,
      1,
      desktop.revision - 1,
      actorId,
    )).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    const restored = await restorePortalPublication(
      testDb.db,
      City.XIAN,
      PortalViewport.DESKTOP,
      1,
      desktop.revision,
      actorId,
    );
    expect(restored).toMatchObject({ revision: desktop.revision + 1, scene: { elements: [{ id: "desktop-0" }] } });
    expect(await testDb.db.auditLog.count({ where: { action: "PORTAL_PUBLICATION_RESTORE" } })).toBe(1);
  });

  it("inspects uploads before persistence, stores metadata transactionally, and audits deletion", async () => {
    const uploaded = await uploadPortalAsset(testDb.db, {
      fileName: "measured.png",
      mimeType: "image/png",
      bytes: validPng(),
    }, actorId, privateRoot, { category: "BACKGROUND" });
    const stored = await testDb.db.fileAsset.findUniqueOrThrow({
      where: { id: uploaded.id },
      include: { portalAssetMetadata: true },
    });
    expect(stored.portalAssetMetadata).toMatchObject({
      category: "BACKGROUND",
      width: 1,
      height: 1,
      frameCount: 1,
      decodedCostBytes: 4n,
      inspectionStatus: "VALID",
    });
    await savePortalSceneDraft(
      testDb.db,
      City.SHENZHEN,
      PortalViewport.DESKTOP,
      scene("DESKTOP", { id: "cross-city-reference" }),
      0,
      actorId,
    );
    const listed = await listPortalAssets(testDb.db, City.SHANGHAI);
    expect(listed.find(({ id }) => id === uploaded.id)).toMatchObject({
      category: "BACKGROUND",
      width: 1,
      height: 1,
      inspectionStatus: "VALID",
      referenceCounts: { draft: 0, current: 0, history: 0 },
      unused: true,
    });
    expect(listed.find(({ id }) => id === assetId)).toMatchObject({
      referenceCounts: { draft: 1, current: 0, history: 0 },
      unused: false,
    });

    await writeFile(path.join(privateRoot, stored.storageKey), validPng());
    await deletePortalAsset(testDb.db, uploaded.id, actorId, privateRoot);
    expect(await testDb.db.auditLog.findFirst({ where: { action: "PORTAL_ASSET_DELETE", targetId: uploaded.id } })).not.toBeNull();
  });

  it("keeps failed deletion cleanup in recoverable quarantine and records no false success", async () => {
    const uploaded = await uploadPortalAsset(testDb.db, {
      fileName: "cleanup-failure.png",
      mimeType: "image/png",
      bytes: validPng(),
    }, actorId, privateRoot);
    const deleting = deletePortalAsset as unknown as (
      db: PrismaClient,
      asset: string,
      actor: string,
      root: string,
      hooks: { beforeDeleteQuarantineCleanup?: (quarantinePath: string) => void },
    ) => Promise<void>;
    await expect(deleting(testDb.db, uploaded.id, actorId, privateRoot, {
      beforeDeleteQuarantineCleanup: () => {
        throw new Error("injected-cleanup-failure");
      },
    })).rejects.toMatchObject({ code: "ASSET_CLEANUP_FAILED" });

    expect(await testDb.db.fileAsset.findUnique({ where: { id: uploaded.id } })).toBeNull();
    expect(await testDb.db.auditLog.count({
      where: { action: "PORTAL_ASSET_DELETE", targetId: uploaded.id, result: "SUCCESS" },
    })).toBe(0);
    expect(await testDb.db.auditLog.count({
      where: { action: "PORTAL_ASSET_CLEANUP", targetId: uploaded.id, result: "FAILURE" },
    })).toBe(1);
    const quarantineDirectory = path.join(privateRoot, ".portal-delete-quarantine");
    const [quarantined] = await readdir(quarantineDirectory);
    expect(quarantined).toBeDefined();
    expect(await readFile(path.join(quarantineDirectory, String(quarantined))))
      .toEqual(Buffer.from(validPng()));
  });

  it("records the quarantine key when transaction compensation cannot restore the file", async () => {
    const uploaded = await uploadPortalAsset(testDb.db, {
      fileName: "restore-failure.png",
      mimeType: "image/png",
      bytes: validPng(),
    }, actorId, privateRoot);
    await expect(deletePortalAsset(testDb.db, uploaded.id, actorId, privateRoot, {
      afterDeleteReferenceCheck: async () => {
        await rm(path.join(privateRoot, "portal"), { recursive: true, force: true });
        throw new Error("injected-delete-transaction-failure");
      },
    })).rejects.toMatchObject({ code: "ASSET_CLEANUP_FAILED" });

    expect(await testDb.db.fileAsset.findUnique({ where: { id: uploaded.id } })).not.toBeNull();
    const audit = await testDb.db.auditLog.findFirstOrThrow({
      where: {
        action: "PORTAL_ASSET_CLEANUP",
        targetId: uploaded.id,
        result: "FAILURE",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.metadata).toMatchObject({
      phase: "RESTORE",
      quarantineKey: expect.stringContaining(".portal-delete-quarantine/"),
    });
  });

  it.each([
    ["save", "initial"],
    ["save", "existing"],
    ["copy", "initial"],
    ["copy", "existing"],
    ["restore", "initial"],
    ["restore", "existing"],
  ] as const)(
    "translates a two-client %s %s-row race into one success and one draft conflict",
    async (operation, rowState) => {
      const first = createPrismaClient(testDb.databaseUrl, { busyTimeoutMs: 100 });
      const second = createPrismaClient(testDb.databaseUrl, { busyTimeoutMs: 100 });
      const city = City.XIAN;
      const viewport = operation === "copy" ? PortalViewport.MOBILE : PortalViewport.DESKTOP;
      let expectedRevision = 0;
      let action = "PORTAL_DRAFT_SAVE";
      let invoke: (db: PrismaClient, suffix: string) => Promise<unknown>;
      let attemptCount = 0;
      let initialReadCount = 0;
      let releaseInitialReads!: () => void;
      const initialReadsComplete = new Promise<void>((resolve) => {
        releaseInitialReads = resolve;
      });
      const raceHooks = {
        beforeRevisionMutationAttempt: () => {
          attemptCount += 1;
        },
        afterDraftRevisionRead: async () => {
          if (initialReadCount >= 2) return;
          initialReadCount += 1;
          if (initialReadCount === 2) releaseInitialReads();
          await initialReadsComplete;
        },
      };
      try {
        if (operation === "save") {
          if (rowState === "existing") {
            const existing = await savePortalSceneDraft(
              testDb.db,
              city,
              viewport,
              scene("DESKTOP", { id: "seed" }),
              0,
              actorId,
            );
            expectedRevision = existing.revision;
          }
          const saveWithHooks = savePortalSceneDraft as unknown as (
            db: PrismaClient,
            city: City,
            viewport: PortalViewport,
            input: unknown,
            expectedRevision: number,
            actorId: string,
            hooks: typeof raceHooks,
          ) => Promise<unknown>;
          invoke = (db, suffix) => saveWithHooks(
            db,
            city,
            viewport,
            scene("DESKTOP", { id: `winner-${suffix}` }),
            expectedRevision,
            actorId,
            raceHooks,
          );
        } else if (operation === "copy") {
          action = "PORTAL_DRAFT_COPY";
          const desktop = await savePortalSceneDraft(
            testDb.db,
            city,
            PortalViewport.DESKTOP,
            scene("DESKTOP", { id: "copy-source" }),
            0,
            actorId,
          );
          if (rowState === "existing") {
            const existing = await savePortalSceneDraft(
              testDb.db,
              city,
              PortalViewport.MOBILE,
              scene("MOBILE", { id: "mobile-seed" }),
              0,
              actorId,
            );
            expectedRevision = existing.revision;
          }
          const copyWithHooks = copyDesktopSceneToMobile as unknown as (
            db: PrismaClient,
            city: City,
            desktopRevision: number,
            mobileRevision: number,
            actorId: string,
            hooks: typeof raceHooks,
          ) => Promise<unknown>;
          invoke = (db) => copyWithHooks(
            db,
            city,
            desktop.revision,
            expectedRevision,
            actorId,
            raceHooks,
          );
        } else {
          action = "PORTAL_PUBLICATION_RESTORE";
          const sourceScene = scene("DESKTOP", { id: "restore-source" });
          await testDb.db.guidePortalPublication.create({
            data: {
              city,
              viewport,
              version: 1,
              canvasWidth: 1_440,
              canvasHeight: 900,
              elements: [{
                id: "restore-source",
                kind: "IMAGE",
                assetId,
                x: 10,
                y: 20,
                width: 240,
                height: 120,
                zIndex: 0,
                altText: "restore-source",
              }],
              sceneVersion: 1,
              scene: sourceScene,
              publishedById: actorId,
              publishedBySnapshot: {},
            },
          });
          if (rowState === "existing") {
            const existing = await savePortalSceneDraft(
              testDb.db,
              city,
              viewport,
              scene("DESKTOP", { id: "restore-seed" }),
              0,
              actorId,
            );
            expectedRevision = existing.revision;
          }
          const restoreWithHooks = restorePortalPublication as unknown as (
            db: PrismaClient,
            city: City,
            viewport: PortalViewport,
            version: number,
            expectedRevision: number,
            actorId: string,
            hooks: typeof raceHooks,
          ) => Promise<unknown>;
          invoke = (db) => restoreWithHooks(
            db,
            city,
            viewport,
            1,
            expectedRevision,
            actorId,
            raceHooks,
          );
        }

        const baselineAudits = await testDb.db.auditLog.count({ where: { action } });
        const results = await Promise.allSettled([
          invoke(first, "first"),
          invoke(second, "second"),
        ]);
        expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        const rejection = results.find(({ status }) => status === "rejected");
        expect(rejection).toMatchObject({
          status: "rejected",
          reason: { code: "DRAFT_CONFLICT" },
        });
        if (rejection?.status === "rejected") {
          expect(rejection.reason).not.toMatchObject({ code: "P1008" });
        }
        expect(initialReadCount).toBe(2);
        expect(attemptCount).toBe(3);

        const stored = await testDb.db.guidePortalDraft.findUniqueOrThrow({
          where: { city_viewport: { city, viewport } },
        });
        expect(stored.draftRevision).toBe(expectedRevision + 1);
        const storedScene = stored.scene as PortalSceneV1;
        expect(await testDb.db.guidePortalAssetReference.count({
          where: { draftId: stored.id },
        })).toBe(extractSceneAssetReferences(storedScene).length);
        expect(await testDb.db.auditLog.count({ where: { action } })).toBe(baselineAudits + 1);
      } finally {
        await first.$disconnect();
        await second.$disconnect();
      }
    },
    15_000,
  );

  it("preserves fillEnabled false when copying desktop draft to mobile", async () => {
    const desktop: PortalSceneV1 = {
      sceneVersion: 1,
      viewport: "DESKTOP",
      requiresMobileReview: false,
      background: {
        assetId: null,
        fitMode: "COVER",
        positionX: 50,
        positionY: 50,
        backgroundColor: "#FFFFFF",
        locked: false,
      },
      elements: [
        {
          id: "hollow-triangle",
          name: "空心三角",
          type: "TRIANGLE",
          fillEnabled: false,
          fill: null,
          lastFillColor: "#DCEBFA",
          stroke: "#1E88E5",
          strokeWidth: 4,
          dash: "DASHED",
          shadow: null,
          x: 120,
          y: 140,
          width: 240,
          height: 180,
          rotation: 0,
          opacity: 1,
          zIndex: 0,
          locked: false,
          hidden: false,
        },
        {
          id: "filled-rect",
          name: "实心矩形",
          type: "RECT",
          fillEnabled: true,
          fill: "#AABBCC",
          lastFillColor: "#AABBCC",
          stroke: null,
          strokeWidth: 0,
          dash: "SOLID",
          shadow: null,
          x: 500,
          y: 200,
          width: 180,
          height: 120,
          rotation: 0,
          opacity: 1,
          zIndex: 1,
          locked: false,
          hidden: false,
        },
      ],
    };

    const saved = await savePortalSceneDraft(
      testDb.db,
      City.SHENZHEN,
      PortalViewport.DESKTOP,
      desktop,
      0,
      actorId,
    );
    const copied = await copyDesktopSceneToMobile(
      testDb.db,
      City.SHENZHEN,
      saved.revision,
      0,
      actorId,
    );

    expect(copied.scene.elements.find(({ id }) => id === "hollow-triangle")).toMatchObject({
      type: "TRIANGLE",
      fillEnabled: false,
      fill: null,
      lastFillColor: "#DCEBFA",
      stroke: "#1E88E5",
      dash: "DASHED",
      opacity: 1,
    });
    expect(copied.scene.elements.find(({ id }) => id === "filled-rect")).toMatchObject({
      type: "RECT",
      fillEnabled: true,
      fill: "#AABBCC",
      lastFillColor: "#AABBCC",
      stroke: null,
    });
  });
});

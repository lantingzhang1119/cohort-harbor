import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { City, FileAssetKind, PortalViewport } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import {
  assertSceneBitmapBudget,
  extractSceneAssetReferences,
  type SceneAssetReference,
} from "@/features/portal/portal-asset-references";
import { inspectPortalImage, type PortalImageInput } from "@/features/portal/portal-file-validation";
import {
  normalizePortalScene,
  PORTAL_CANVAS_SIZES as V1_PORTAL_CANVAS_SIZES,
  portalSceneV1Schema,
  type PortalElement,
  type PortalSceneV1,
} from "@/features/portal/portal-scene";
import { portalSceneCanvasSize } from "@/features/portal/portal-geometry";
import {
  parseStoredPortalScene,
  projectSceneToLegacyElements,
} from "@/features/portal/portal-scene-adapter";
import {
  PORTAL_CANVAS_SIZES,
  clampPortalElements,
  portalElementSchema,
  type PortalElementInput,
  type PortalElementSaveInput,
} from "@/features/portal/portal-schemas";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

type PortalDb = PrismaClient;
type PortalTransaction = Prisma.TransactionClient;
type PortalElementResponse = PortalElementInput & { assetUrl: string };

export class PortalServiceError extends Error {
  constructor(
    public readonly code:
      | "DRAFT_INCOMPLETE"
      | "DRAFT_CONFLICT"
      | "DRAFT_EMPTY"
      | "MOBILE_REVIEW_REQUIRED"
      | "INVALID_ASSET_REFERENCE"
      | "PUBLICATION_NOT_FOUND"
      | "ASSET_NOT_FOUND"
      | "ASSET_REFERENCED"
      | "ASSET_CLEANUP_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PortalServiceError";
  }
}

export type PortalMutationHooks = {
  beforeSaveTransaction?: () => void | Promise<void>;
  beforeDeleteTransaction?: () => void | Promise<void>;
  afterAssetValidation?: () => void | Promise<void>;
  afterFirstPublication?: () => void | Promise<void>;
  afterAudit?: () => void | Promise<void>;
  afterDeleteReferenceCheck?: () => void | Promise<void>;
  afterAssetFileWrite?: (absolutePath: string) => void | Promise<void>;
  beforeDeleteQuarantineCleanup?: (absolutePath: string) => void | Promise<void>;
  beforeRevisionMutationAttempt?: (attempt: number) => void | Promise<void>;
  afterDraftRevisionRead?: () => void | Promise<void>;
};

async function actorSnapshot(db: Pick<PrismaClient, "user"> | PortalTransaction, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  return snapshotUserIdentity(actor);
}

function parseElements(value: Prisma.JsonValue): PortalElementInput[] {
  return portalElementSchema.array().parse(value);
}

function projectRenderedSceneToLegacyElements(scene: PortalSceneV1) {
  return projectSceneToLegacyElements({
    ...scene,
    elements: scene.elements.filter((element) => !element.hidden && element.opacity > 0),
  });
}

async function validateAssetReferences(
  db: Pick<PrismaClient, "fileAsset"> | PortalTransaction,
  elements: PortalElementInput[],
) {
  const ids = [...new Set(elements.map((element) => element.assetId))];
  if (ids.length === 0) return;
  const assets = await db.fileAsset.findMany({
    where: { id: { in: ids }, kind: FileAssetKind.PORTAL_IMAGE },
    select: { id: true },
  });
  if (assets.length !== ids.length) {
    throw new PortalServiceError("INVALID_ASSET_REFERENCE", "布局引用的门户素材不存在或类型不正确");
  }
}

async function replaceDraftAssetReferences(transaction: PortalTransaction, draftId: string, elements: PortalElementInput[]) {
  await transaction.guidePortalAssetReference.deleteMany({ where: { draftId } });
  if (elements.length > 0) await transaction.guidePortalAssetReference.createMany({
    data: elements.map((element) => ({ assetId: element.assetId, draftId, elementId: element.id })),
  });
}

async function createPublicationAssetReferences(transaction: PortalTransaction, publicationId: string, elements: PortalElementInput[]) {
  if (elements.length > 0) await transaction.guidePortalAssetReference.createMany({
    data: elements.map((element) => ({ assetId: element.assetId, publicationId, elementId: element.id })),
  });
}

async function replaceSceneDraftAssetReferences(
  transaction: PortalTransaction,
  draftId: string,
  references: SceneAssetReference[],
) {
  await transaction.guidePortalAssetReference.deleteMany({ where: { draftId } });
  if (references.length > 0) {
    await transaction.guidePortalAssetReference.createMany({
      data: references.map(({ assetId, elementId }) => ({ assetId, draftId, elementId })),
    });
  }
}

async function createScenePublicationAssetReferences(
  transaction: PortalTransaction,
  publicationId: string,
  references: SceneAssetReference[],
) {
  if (references.length > 0) {
    await transaction.guidePortalAssetReference.createMany({
      data: references.map(({ assetId, elementId }) => ({ assetId, publicationId, elementId })),
    });
  }
}

function responseElements(layout: { elements: Prisma.JsonValue }) {
  const elements: PortalElementResponse[] = parseElements(layout.elements).map((element) => ({
    ...element,
    assetUrl: `/api/files/${encodeURIComponent(element.assetId)}`,
  }));
  return elements;
}

function draftResponse(layout: {
  id: string; city: City; viewport: PortalViewport; canvasWidth: number; canvasHeight: number;
  elements: Prisma.JsonValue; sceneVersion: number; scene: Prisma.JsonValue | null;
  draftRevision: number; updatedBySnapshot: Prisma.JsonValue; updatedAt: Date;
}) {
  return {
    id: layout.id,
    city: layout.city,
    viewport: layout.viewport,
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    elements: responseElements(layout),
    scene: parseStoredPortalScene(layout),
    revision: layout.draftRevision,
    updatedBySnapshot: layout.updatedBySnapshot,
    updatedAt: layout.updatedAt,
  };
}

function publicationResponse(layout: {
  id: string; city: City; viewport: PortalViewport; version: number; canvasWidth: number; canvasHeight: number;
  elements: Prisma.JsonValue; sceneVersion: number; scene: Prisma.JsonValue | null; createdAt: Date;
}) {
  const scene = storedPublicationScene(layout);
  return {
    id: layout.id,
    city: layout.city,
    viewport: layout.viewport,
    version: layout.version,
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    elements: responseElements(layout),
    sceneVersion: layout.sceneVersion,
    scene,
    createdAt: layout.createdAt,
  };
}

export async function getPortalDraft(db: PortalDb, city: City, viewport: PortalViewport) {
  const draft = await db.guidePortalDraft.findUnique({ where: { city_viewport: { city, viewport } } });
  return draft ? draftResponse(draft) : null;
}

export async function savePortalDraft(
  db: PortalDb,
  city: City,
  viewport: PortalViewport,
  input: PortalElementSaveInput[],
  actorId: string,
  hooks: PortalMutationHooks = {},
) {
  const elements = clampPortalElements(viewport, input);
  const size = PORTAL_CANVAS_SIZES[viewport];
  await hooks.beforeSaveTransaction?.();
  try {
    const draft = await db.$transaction(async (transaction) => {
      const existing = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport } },
      });
      if (existing?.sceneVersion === 1) throw draftConflict();
      const snapshot = await actorSnapshot(transaction, actorId);
      await validateAssetReferences(transaction, elements);
      await hooks.afterAssetValidation?.();
      let saved;
      if (existing) {
        const updated = await transaction.guidePortalDraft.updateMany({
          where: { id: existing.id, sceneVersion: 0 },
          data: {
            ...size,
            elements,
            legacyElements: elements,
            draftRevision: { increment: 1 },
            updatedById: actorId,
            updatedBySnapshot: snapshot,
          },
        });
        if (updated.count === 0) throw draftConflict();
        saved = await transaction.guidePortalDraft.findUniqueOrThrow({ where: { id: existing.id } });
      } else {
        saved = await transaction.guidePortalDraft.create({
          data: { city, viewport, ...size, elements, updatedById: actorId, updatedBySnapshot: snapshot },
        });
      }
      await replaceDraftAssetReferences(transaction, saved.id, elements);
      await writeAuditLog(transaction, {
        actorId,
        action: "PORTAL_DRAFT_SAVE",
        targetType: "GUIDE_PORTAL_DRAFT",
        targetId: saved.id,
        result: "SUCCESS",
        metadata: { city, viewport, elementCount: elements.length },
      });
      return saved;
    });
    return draftResponse(draft);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw draftConflict();
    throw error;
  }
}

export async function copyDesktopDraftToMobile(db: PortalDb, city: City, actorId: string) {
  try {
    const result = await db.$transaction(async (transaction) => {
      const source = await transaction.guidePortalDraft.findUnique({ where: { city_viewport: { city, viewport: PortalViewport.DESKTOP } } });
      if (!source) throw new PortalServiceError("DRAFT_INCOMPLETE", "请先保存桌面草稿");
      const currentTarget = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport: PortalViewport.MOBILE } },
      });
      if (currentTarget?.sceneVersion === 1) throw draftConflict();
      const elements = clampPortalElements(PortalViewport.MOBILE, parseElements(source.elements));
      const snapshot = await actorSnapshot(transaction, actorId);
      await validateAssetReferences(transaction, elements);
      let target;
      if (currentTarget) {
        const updated = await transaction.guidePortalDraft.updateMany({
          where: { id: currentTarget.id, sceneVersion: 0 },
          data: {
            ...PORTAL_CANVAS_SIZES.MOBILE,
            elements,
            legacyElements: elements,
            draftRevision: { increment: 1 },
            updatedById: actorId,
            updatedBySnapshot: snapshot,
          },
        });
        if (updated.count === 0) throw draftConflict();
        target = await transaction.guidePortalDraft.findUniqueOrThrow({ where: { id: currentTarget.id } });
      } else {
        target = await transaction.guidePortalDraft.create({
          data: { city, viewport: PortalViewport.MOBILE, ...PORTAL_CANVAS_SIZES.MOBILE, elements, updatedById: actorId, updatedBySnapshot: snapshot },
        });
      }
      await replaceDraftAssetReferences(transaction, target.id, elements);
      await writeAuditLog(transaction, { actorId, action: "PORTAL_DRAFT_COPY", targetType: "GUIDE_PORTAL_DRAFT", targetId: target.id, result: "SUCCESS", metadata: { city, sourceViewport: "DESKTOP", targetViewport: "MOBILE" } });
      return target;
    });
    return draftResponse(result);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw draftConflict();
    throw error;
  }
}

const publishQueues = new WeakMap<PortalDb, Map<City, Promise<unknown>>>();

async function serializePublication<T>(db: PortalDb, city: City, operation: () => Promise<T>): Promise<T> {
  const queues = publishQueues.get(db) ?? new Map<City, Promise<unknown>>();
  publishQueues.set(db, queues);
  const previous = queues.get(city) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(city, current);
  try {
    return await current;
  } finally {
    if (queues.get(city) === current) queues.delete(city);
  }
}

function isRetryablePublicationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return ["P1008", "P2002", "P2034"].includes(code) || /database is locked|unique constraint.*GuidePortalPublication/i.test(message);
}

async function publishPortalTransaction(db: PortalDb, city: City, actorId: string, hooks: PortalMutationHooks) {
  return db.$transaction(async (transaction) => {
    const snapshot = await actorSnapshot(transaction, actorId);
    const drafts = await transaction.guidePortalDraft.findMany({ where: { city } });
    const desktop = drafts.find((draft) => draft.viewport === PortalViewport.DESKTOP);
    const mobile = drafts.find((draft) => draft.viewport === PortalViewport.MOBILE);
    if (!desktop || !mobile) {
      throw new PortalServiceError("DRAFT_INCOMPLETE", "桌面和手机草稿都保存后才能发布");
    }
    if (desktop.sceneVersion === 1 || mobile.sceneVersion === 1) throw draftConflict();
    const normalized = [desktop, mobile].map((draft) => ({
      draft,
      elements: clampPortalElements(draft.viewport, parseElements(draft.elements)),
    }));
    await validateAssetReferences(transaction, normalized.flatMap((entry) => entry.elements));
    const latest = await transaction.guidePortalPublication.findFirst({
      where: { city }, orderBy: { version: "desc" }, select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const publications = [];
    for (const [index, { draft, elements }] of normalized.entries()) {
      const publication = await transaction.guidePortalPublication.create({
        data: {
          city,
          viewport: draft.viewport,
          version,
          canvasWidth: PORTAL_CANVAS_SIZES[draft.viewport].canvasWidth,
          canvasHeight: PORTAL_CANVAS_SIZES[draft.viewport].canvasHeight,
          elements,
          publishedById: actorId,
          publishedBySnapshot: snapshot,
        },
      });
      publications.push(publication);
      await createPublicationAssetReferences(transaction, publication.id, elements);
      if (index === 0) await hooks.afterFirstPublication?.();
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "PORTAL_PUBLISH",
      targetType: "GUIDE_PORTAL_PUBLICATION",
      result: "SUCCESS",
      metadata: { city, version },
    });
    await hooks.afterAudit?.();
    return { city, version, publications: publications.map(publicationResponse) };
  });
}

export async function publishPortal(db: PortalDb, city: City, actorId: string, hooks: PortalMutationHooks = {}) {
  return serializePublication(db, city, async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await publishPortalTransaction(db, city, actorId, hooks);
      } catch (error) {
        if (!isRetryablePublicationError(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new Error("门户发布重试失败");
  });
}

export async function getPublishedPortal(db: PortalDb, city: City, viewport: PortalViewport) {
  const publication = await db.guidePortalPublication.findFirst({
    where: { city, viewport },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
  });
  if (!publication) return null;
  if (publication.sceneVersion === 1) {
    const scene = portalSceneV1Schema.parse(publication.scene);
    if (scene.viewport !== publication.viewport) {
      throw new Error("发布场景视图与记录不一致");
    }
    return {
      sceneVersion: 1 as const,
      version: publication.version,
      scene,
    };
  }
  if (publication.sceneVersion !== 0) {
    throw new Error(`不支持的门户场景版本：${publication.sceneVersion}`);
  }
  return {
    sceneVersion: 0 as const,
    version: publication.version,
    viewport: publication.viewport,
    canvasWidth: publication.canvasWidth,
    canvasHeight: publication.canvasHeight,
    elements: responseElements(publication),
  };
}

export async function restorePreviousPublication(
  db: PortalDb,
  city: City,
  viewport: PortalViewport,
  actorId: string,
  version?: number,
) {
  try {
    const result = await db.$transaction(async (transaction) => {
      const publications = await transaction.guidePortalPublication.findMany({
        where: { city, viewport, ...(version === undefined ? {} : { version }) },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        take: version === undefined ? 2 : 1,
      });
      const source = version === undefined ? publications[1] : publications[0];
      if (!source) throw new PortalServiceError("PUBLICATION_NOT_FOUND", "没有更早的发布版本");
      const sourceElements = projectRenderedSceneToLegacyElements(storedPublicationScene(source));
      const elements = clampPortalElements(viewport, sourceElements);
      const snapshot = await actorSnapshot(transaction, actorId);
      await validateAssetReferences(transaction, elements);
      const currentTarget = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport } },
      });
      if (currentTarget?.sceneVersion === 1) throw draftConflict();
      let target;
      if (currentTarget) {
        const updated = await transaction.guidePortalDraft.updateMany({
          where: { id: currentTarget.id, sceneVersion: 0 },
          data: {
            ...PORTAL_CANVAS_SIZES[viewport],
            elements,
            legacyElements: elements,
            draftRevision: { increment: 1 },
            updatedById: actorId,
            updatedBySnapshot: snapshot,
          },
        });
        if (updated.count === 0) throw draftConflict();
        target = await transaction.guidePortalDraft.findUniqueOrThrow({ where: { id: currentTarget.id } });
      } else {
        target = await transaction.guidePortalDraft.create({
          data: { city, viewport, ...PORTAL_CANVAS_SIZES[viewport], elements, updatedById: actorId, updatedBySnapshot: snapshot },
        });
      }
      await replaceDraftAssetReferences(transaction, target.id, elements);
      await writeAuditLog(transaction, { actorId, action: "PORTAL_PUBLICATION_RESTORE", targetType: "GUIDE_PORTAL_DRAFT", targetId: target.id, result: "SUCCESS", metadata: { city, viewport, sourceVersion: source.version } });
      return target;
    });
    return draftResponse(result);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw draftConflict();
    throw error;
  }
}

type StoredSceneDraft = {
  id: string;
  city: City;
  viewport: PortalViewport;
  canvasWidth: number;
  canvasHeight: number;
  elements: Prisma.JsonValue;
  sceneVersion: number;
  scene: Prisma.JsonValue | null;
  legacyElements: Prisma.JsonValue | null;
  draftRevision: number;
  updatedBySnapshot: Prisma.JsonValue;
  updatedAt: Date;
};

function storedDraftScene(draft: Pick<StoredSceneDraft, "viewport" | "sceneVersion" | "scene" | "elements">) {
  return parseStoredPortalScene(draft);
}

function storedPublicationScene(publication: {
  viewport: PortalViewport;
  sceneVersion: number;
  scene: Prisma.JsonValue | null;
  elements: Prisma.JsonValue;
}) {
  return parseStoredPortalScene(publication);
}

function sceneDraftResponse(draft: StoredSceneDraft) {
  const scene = storedDraftScene(draft);
  const { canvasWidth, canvasHeight } = portalSceneCanvasSize(scene);
  return {
    id: draft.id,
    city: draft.city,
    viewport: draft.viewport,
    canvasWidth,
    canvasHeight,
    scene,
    revision: draft.draftRevision,
    updatedBySnapshot: draft.updatedBySnapshot,
    updatedAt: draft.updatedAt,
  };
}

function draftConflict() {
  return new PortalServiceError("DRAFT_CONFLICT", "草稿已被其他管理员更新，请重新载入最新版本");
}

function isUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "P2002" || /unique constraint/i.test(message);
}

function isRetryableDraftMutationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return ["P1008", "P2034"].includes(code) || /database is locked|busy snapshot/i.test(message);
}

async function runRevisionCheckedMutation<T>(
  operation: () => Promise<T>,
  beforeAttempt?: (attempt: number) => void | Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await beforeAttempt?.(attempt + 1);
      return await operation();
    } catch (error) {
      if (error instanceof PortalServiceError) throw error;
      if (!isUniqueConstraintError(error) && !isRetryableDraftMutationError(error)) throw error;
      if (attempt === 3) throw draftConflict();
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw draftConflict();
}

async function writeSceneDraft(
  transaction: PortalTransaction,
  city: City,
  viewport: PortalViewport,
  scene: PortalSceneV1,
  expectedRevision: number,
  actorId: string,
  action: "PORTAL_DRAFT_SAVE" | "PORTAL_DRAFT_COPY" | "PORTAL_MOBILE_REVIEW_CONFIRM" | "PORTAL_PUBLICATION_RESTORE",
  metadata: Record<string, string | number | boolean | null>,
  hooks: Pick<PortalMutationHooks, "afterDraftRevisionRead"> = {},
) {
  const existing = await transaction.guidePortalDraft.findUnique({
    where: { city_viewport: { city, viewport } },
  });
  if (existing ? existing.draftRevision !== expectedRevision : expectedRevision !== 0) {
    throw draftConflict();
  }
  await hooks.afterDraftRevisionRead?.();

  const storedScene = existing?.sceneVersion === 1
    ? storedDraftScene(existing as StoredSceneDraft)
    : null;
  const authoritativeScene = viewport === PortalViewport.MOBILE
    && action !== "PORTAL_MOBILE_REVIEW_CONFIRM"
    && storedScene?.requiresMobileReview
    ? { ...scene, requiresMobileReview: true }
    : scene;

  await assertSceneBitmapBudget(transaction, authoritativeScene);
  const snapshot = await actorSnapshot(transaction, actorId);
  const references = extractSceneAssetReferences(authoritativeScene);
  const legacyProjection = projectRenderedSceneToLegacyElements(authoritativeScene);
  const logicalSize = portalSceneCanvasSize(authoritativeScene);
  const size = {
    canvasWidth: Math.round(logicalSize.canvasWidth),
    canvasHeight: Math.round(logicalSize.canvasHeight),
  };
  let saved;
  if (!existing) {
    saved = await transaction.guidePortalDraft.create({
      data: {
        city,
        viewport,
        ...size,
        elements: legacyProjection,
        sceneVersion: 1,
        scene: authoritativeScene as Prisma.InputJsonValue,
        draftRevision: 1,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
  } else {
    const updated = await transaction.guidePortalDraft.updateMany({
      where: { id: existing.id, draftRevision: expectedRevision },
      data: {
        ...size,
        elements: legacyProjection,
        sceneVersion: 1,
        scene: authoritativeScene as Prisma.InputJsonValue,
        legacyElements: existing.sceneVersion === 0 && existing.legacyElements === null
          ? existing.elements as Prisma.InputJsonValue
          : undefined,
        draftRevision: { increment: 1 },
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    if (updated.count === 0) throw draftConflict();
    saved = await transaction.guidePortalDraft.findUniqueOrThrow({ where: { id: existing.id } });
  }

  await replaceSceneDraftAssetReferences(transaction, saved.id, references);
  await writeAuditLog(transaction, {
    actorId,
    action,
    targetType: "GUIDE_PORTAL_DRAFT",
    targetId: saved.id,
    result: "SUCCESS",
    metadata: {
      city,
      viewport,
      revision: saved.draftRevision,
      elementCount: authoritativeScene.elements.length,
      ...metadata,
    },
  });
  return saved as StoredSceneDraft;
}

export async function savePortalSceneDraft(
  db: PortalDb,
  city: City,
  viewport: PortalViewport,
  input: unknown,
  expectedRevision: number,
  actorId: string,
  hooks: Pick<
    PortalMutationHooks,
    "beforeSaveTransaction"
      | "afterAssetValidation"
      | "beforeRevisionMutationAttempt"
      | "afterDraftRevisionRead"
  > = {},
) {
  const scene = normalizePortalScene(viewport, input);
  await hooks.beforeSaveTransaction?.();
  const saved = await runRevisionCheckedMutation(() =>
    db.$transaction(async (transaction) => {
      const result = await writeSceneDraft(
        transaction,
        city,
        viewport,
        scene,
        expectedRevision,
        actorId,
        "PORTAL_DRAFT_SAVE",
        {},
        hooks,
      );
      await hooks.afterAssetValidation?.();
      return result;
    }),
    hooks.beforeRevisionMutationAttempt,
  );
  return sceneDraftResponse(saved);
}

function mobileRevisionArguments(
  desktopOrRevisions: number | {
    desktop?: number;
    mobile?: number;
    desktopRevision?: number;
    mobileRevision?: number;
    DESKTOP?: number;
    MOBILE?: number;
  },
  mobileOrActor: number | string,
  maybeActor?: string,
) {
  if (typeof desktopOrRevisions === "number") {
    return {
      desktopRevision: desktopOrRevisions,
      mobileRevision: Number(mobileOrActor),
      actorId: maybeActor ?? "",
    };
  }
  return {
    desktopRevision: desktopOrRevisions.desktop
      ?? desktopOrRevisions.desktopRevision
      ?? desktopOrRevisions.DESKTOP,
    mobileRevision: desktopOrRevisions.mobile
      ?? desktopOrRevisions.mobileRevision
      ?? desktopOrRevisions.MOBILE,
    actorId: String(mobileOrActor),
  };
}

function proportionalMobileSize(
  element: PortalElement,
  minimum: number,
  desktopSize: { canvasWidth: number; canvasHeight: number } = V1_PORTAL_CANVAS_SIZES.DESKTOP,
  mobileSize: { canvasWidth: number; canvasHeight: number } = V1_PORTAL_CANVAS_SIZES.MOBILE,
) {
  const viewportScale = mobileSize.canvasWidth / desktopSize.canvasWidth;
  const sourceWidth = element.width * viewportScale;
  const sourceHeight = element.height * viewportScale;
  const sourceAspect = sourceWidth / sourceHeight;
  const radians = element.rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const renderedStroke = (
    element.type === "RECT"
    || element.type === "CIRCLE"
    || element.type === "ELLIPSE"
    || element.type === "ROUND_RECT"
    || element.type === "TRIANGLE"
  ) && element.stroke !== null
    ? Math.max(1, element.strokeWidth * viewportScale)
    : 0;
  const candidateSize = (aspect: number) => {
    let width = sourceWidth;
    let height = sourceHeight;
    if (aspect > sourceAspect) width = height * aspect;
    else if (aspect < sourceAspect) height = width / aspect;
    const minimumScale = Math.max(1, minimum / width, minimum / height);
    width *= minimumScale;
    height *= minimumScale;
    const canvasScale = Math.min(
      1,
      mobileSize.canvasWidth / width,
      mobileSize.canvasHeight / height,
    );
    return { width: width * canvasScale, height: height * canvasScale };
  };
  const minimumAfterRenderedFit = (aspect: number) => {
    const candidate = candidateSize(aspect);
    const renderedWidth =
      candidate.width * cosine + candidate.height * sine + renderedStroke;
    const renderedHeight =
      candidate.width * sine + candidate.height * cosine + renderedStroke;
    const fitScale = Math.min(
      1,
      mobileSize.canvasWidth / renderedWidth,
      mobileSize.canvasHeight / renderedHeight,
    );
    return Math.min(candidate.width, candidate.height) * fitScale;
  };
  let representableAspect = sourceAspect;
  if (minimumAfterRenderedFit(sourceAspect) < 1) {
    if (sourceAspect < 1) {
      let impossible = sourceAspect;
      let possible = 1;
      for (let iteration = 0; iteration < 64; iteration += 1) {
        const candidate = (impossible + possible) / 2;
        if (minimumAfterRenderedFit(candidate) >= 1) possible = candidate;
        else impossible = candidate;
      }
      representableAspect = possible;
    } else {
      let possible = 1;
      let impossible = sourceAspect;
      for (let iteration = 0; iteration < 64; iteration += 1) {
        const candidate = (possible + impossible) / 2;
        if (minimumAfterRenderedFit(candidate) >= 1) possible = candidate;
        else impossible = candidate;
      }
      representableAspect = possible;
    }
  }
  // Geometry has a one-pixel floor. Ratios that cannot survive a
  // rotation/stroke-aware fit are capped once before all subsequent uniform
  // scaling, so scene normalization never clamps one dimension independently.
  return candidateSize(representableAspect);
}

function mobileElement(
  element: PortalElement,
  desktopSize: { canvasWidth: number; canvasHeight: number } = V1_PORTAL_CANVAS_SIZES.DESKTOP,
  mobileSize: { canvasWidth: number; canvasHeight: number } = V1_PORTAL_CANVAS_SIZES.MOBILE,
): unknown {
  const scale = mobileSize.canvasWidth / desktopSize.canvasWidth;
  const sourceCenterX = element.x + element.width / 2;
  const sourceCenterY = element.y + element.height / 2;
  let width = element.width * scale;
  let height = element.height * scale;
  let adjusted: Record<string, unknown> = { ...element };
  const scaledShadow = (
    shadow: Extract<PortalElement, { type: "RECT" }>["shadow"],
  ) => shadow === null ? null : {
    ...shadow,
    blur: shadow.blur * scale,
    offsetX: shadow.offsetX * scale,
    offsetY: shadow.offsetY * scale,
  };

  if (element.type === "IMAGE") {
    ({ width, height } = proportionalMobileSize(element, 24, desktopSize, mobileSize));
    adjusted = { ...adjusted, cornerRadius: element.cornerRadius * scale };
  } else if (element.type === "TEXT") {
    const fontSize = Math.max(14, element.fontSize * scale);
    width = Math.max(120, width);
    height = Math.max(44, height, fontSize * Math.max(1.2, element.lineHeight) * 2);
    adjusted = {
      ...adjusted,
      fontSize,
      lineHeight: Math.max(1.2, element.lineHeight),
      letterSpacing: element.letterSpacing * scale,
    };
  } else if (element.type === "BUTTON") {
    const fontSize = Math.max(14, element.fontSize * scale);
    width = Math.max(96, width);
    height = Math.max(44, height);
    adjusted = {
      ...adjusted,
      fontSize,
      lineHeight: Math.max(1.2, element.lineHeight),
      cornerRadius: element.cornerRadius * scale,
      border: element.border === null
        ? null
        : { ...element.border, width: Math.max(0.5, element.border.width * scale) },
      shadow: scaledShadow(element.shadow),
    };
  } else if (element.type === "ICON") {
    ({ width, height } = proportionalMobileSize(element, 32, desktopSize, mobileSize));
  } else if (element.type === "MARKER") {
    ({ width, height } = proportionalMobileSize(element, 44, desktopSize, mobileSize));
  } else if (element.type === "LINE") {
    width = Math.max(1, element.width * scale);
    height = Math.max(1, element.height * scale);
    adjusted = {
      ...adjusted,
      strokeWidth: Math.max(1, element.strokeWidth * scale),
      shadow: scaledShadow(element.shadow),
    };
  } else if (element.type === "ARROW") {
    width = Math.max(1, element.width * scale);
    height = Math.max(1, element.height * scale);
    adjusted = {
      ...adjusted,
      strokeWidth: Math.max(1, element.strokeWidth * scale),
      pointerLength: Math.max(6, element.pointerLength * scale),
      pointerWidth: Math.max(6, element.pointerWidth * scale),
      shadow: scaledShadow(element.shadow),
    };
  } else if (element.type === "FREEHAND") {
    width = Math.max(1, element.width * scale);
    height = Math.max(1, element.height * scale);
    adjusted = {
      ...adjusted,
      points: element.points.map((value) => value * scale),
      strokeWidth: element.strokeWidth * scale,
    };
  } else if (
    element.type === "RECT"
    || element.type === "CIRCLE"
    || element.type === "ELLIPSE"
    || element.type === "ROUND_RECT"
    || element.type === "TRIANGLE"
  ) {
    ({ width, height } = proportionalMobileSize(element, 24, desktopSize, mobileSize));
    adjusted = {
      ...adjusted,
      strokeWidth: element.stroke === null ? element.strokeWidth : Math.max(1, element.strokeWidth * scale),
      shadow: scaledShadow(element.shadow),
      ...(element.type === "ROUND_RECT" ? { cornerRadius: element.cornerRadius * scale } : {}),
    };
  }

  return {
    ...adjusted,
    width,
    height,
    x: sourceCenterX / desktopSize.canvasWidth * mobileSize.canvasWidth - width / 2,
    y: sourceCenterY / desktopSize.canvasHeight * mobileSize.canvasHeight - height / 2,
  };
}

export async function copyDesktopSceneToMobile(
  db: PortalDb,
  city: City,
  desktopOrRevisions: number | {
    desktop?: number;
    mobile?: number;
    desktopRevision?: number;
    mobileRevision?: number;
    DESKTOP?: number;
    MOBILE?: number;
  },
  mobileOrActor: number | string,
  maybeActor?: string,
  hooks: Pick<
    PortalMutationHooks,
    "beforeRevisionMutationAttempt" | "afterDraftRevisionRead"
  > = {},
) {
  const { desktopRevision, mobileRevision, actorId } = mobileRevisionArguments(
    desktopOrRevisions,
    mobileOrActor,
    maybeActor,
  );
  if (desktopRevision === undefined || mobileRevision === undefined || !actorId) throw draftConflict();
  const saved = await runRevisionCheckedMutation(() =>
    db.$transaction(async (transaction) => {
      const desktop = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport: PortalViewport.DESKTOP } },
      });
      const mobile = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport: PortalViewport.MOBILE } },
      });
      if (!desktop) throw new PortalServiceError("DRAFT_INCOMPLETE", "请先保存桌面草稿");
      if (
        desktop.draftRevision !== desktopRevision
        || (mobile ? mobile.draftRevision !== mobileRevision : mobileRevision !== 0)
      ) {
        throw draftConflict();
      }
      const source = storedDraftScene(desktop as StoredSceneDraft);
      const desktopSize = portalSceneCanvasSize(source);
      const mobileSceneShape = {
        ...source,
        viewport: PortalViewport.MOBILE,
      };
      const mobileSize = portalSceneCanvasSize(mobileSceneShape);
      const copied = normalizePortalScene(PortalViewport.MOBILE, {
        ...mobileSceneShape,
        requiresMobileReview: true,
        elements: source.elements.map((element) => mobileElement(element, desktopSize, mobileSize)),
      });
      return writeSceneDraft(
        transaction,
        city,
        PortalViewport.MOBILE,
        copied,
        mobileRevision,
        actorId,
        "PORTAL_DRAFT_COPY",
        { sourceRevision: desktopRevision },
        hooks,
      );
    }),
    hooks.beforeRevisionMutationAttempt,
  );
  return sceneDraftResponse(saved);
}

export async function confirmMobileSceneReview(
  db: PortalDb,
  city: City,
  expectedRevision: number,
  actorId: string,
) {
  const saved = await runRevisionCheckedMutation(() =>
    db.$transaction(async (transaction) => {
      const mobile = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport: PortalViewport.MOBILE } },
      });
      if (!mobile) throw new PortalServiceError("DRAFT_INCOMPLETE", "请先保存手机草稿");
      if (mobile.draftRevision !== expectedRevision) throw draftConflict();
      const scene = storedDraftScene(mobile as StoredSceneDraft);
      return writeSceneDraft(
        transaction,
        city,
        PortalViewport.MOBILE,
        { ...scene, requiresMobileReview: false },
        expectedRevision,
        actorId,
        "PORTAL_MOBILE_REVIEW_CONFIRM",
        {},
      );
    })
  );
  return sceneDraftResponse(saved);
}

type PortalDraftRevisionPair = {
  desktop?: number;
  mobile?: number;
  desktopRevision?: number;
  mobileRevision?: number;
  DESKTOP?: number;
  MOBILE?: number;
};

function publicationRevisions(revisions: PortalDraftRevisionPair) {
  return {
    desktop: revisions.desktop ?? revisions.desktopRevision ?? revisions.DESKTOP,
    mobile: revisions.mobile ?? revisions.mobileRevision ?? revisions.MOBILE,
  };
}

function sceneIsEmpty(scene: PortalSceneV1) {
  return scene.background.assetId === null && !scene.elements.some((element) =>
    !element.hidden
    && element.opacity > 0
    && (element.type !== "TEXT" || element.text.trim().length > 0)
  );
}

async function publishPortalScenesTransaction(
  db: PortalDb,
  city: City,
  revisions: PortalDraftRevisionPair,
  actorId: string,
  hooks: Pick<PortalMutationHooks, "afterFirstPublication" | "afterAudit">,
) {
  return db.$transaction(async (transaction) => {
    const expected = publicationRevisions(revisions);
    const drafts = await transaction.guidePortalDraft.findMany({ where: { city } });
    const desktop = drafts.find(({ viewport }) => viewport === PortalViewport.DESKTOP);
    const mobile = drafts.find(({ viewport }) => viewport === PortalViewport.MOBILE);
    if (!desktop || !mobile || desktop.sceneVersion !== 1 || mobile.sceneVersion !== 1) {
      throw new PortalServiceError("DRAFT_INCOMPLETE", "桌面和手机 V1 草稿都保存后才能发布");
    }
    if (
      expected.desktop === undefined
      || expected.mobile === undefined
      || desktop.draftRevision !== expected.desktop
      || mobile.draftRevision !== expected.mobile
    ) {
      throw draftConflict();
    }

    const desktopScene = storedDraftScene(desktop as StoredSceneDraft);
    const mobileScene = storedDraftScene(mobile as StoredSceneDraft);
    if (sceneIsEmpty(desktopScene) || sceneIsEmpty(mobileScene)) {
      throw new PortalServiceError("DRAFT_EMPTY", "桌面和手机场景都必须包含背景或至少一个可见元素");
    }
    if (mobileScene.requiresMobileReview) {
      throw new PortalServiceError("MOBILE_REVIEW_REQUIRED", "手机场景必须经管理员明确检查后才能发布");
    }
    await assertSceneBitmapBudget(transaction, desktopScene);
    await assertSceneBitmapBudget(transaction, mobileScene);

    const latest = await transaction.guidePortalPublication.findFirst({
      where: { city },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const snapshot = await actorSnapshot(transaction, actorId);
    const publications = [];
    for (const [index, scene] of [desktopScene, mobileScene].entries()) {
      const logicalSize = portalSceneCanvasSize(scene);
      const size = {
        canvasWidth: Math.round(logicalSize.canvasWidth),
        canvasHeight: Math.round(logicalSize.canvasHeight),
      };
      const legacyProjection = projectRenderedSceneToLegacyElements(scene);
      const publication = await transaction.guidePortalPublication.create({
        data: {
          city,
          viewport: scene.viewport,
          version,
          ...size,
          elements: legacyProjection,
          sceneVersion: 1,
          scene: scene as Prisma.InputJsonValue,
          publishedById: actorId,
          publishedBySnapshot: snapshot,
        },
      });
      await createScenePublicationAssetReferences(
        transaction,
        publication.id,
        extractSceneAssetReferences(scene),
      );
      publications.push({
        id: publication.id,
        city,
        viewport: scene.viewport,
        version,
        ...logicalSize,
        scene,
        publishedBySnapshot: snapshot,
        createdAt: publication.createdAt,
      });
      if (index === 0) await hooks.afterFirstPublication?.();
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "PORTAL_PUBLISH",
      targetType: "GUIDE_PORTAL_PUBLICATION",
      result: "SUCCESS",
      metadata: {
        city,
        version,
        desktopRevision: expected.desktop,
        mobileRevision: expected.mobile,
      },
    });
    await hooks.afterAudit?.();
    return { city, version, publications };
  });
}

export async function publishPortalScenes(
  db: PortalDb,
  city: City,
  revisions: PortalDraftRevisionPair,
  actorId: string,
  hooks: Pick<PortalMutationHooks, "afterFirstPublication" | "afterAudit"> = {},
) {
  return serializePublication(db, city, async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await publishPortalScenesTransaction(db, city, revisions, actorId, hooks);
      } catch (error) {
        if (!isRetryablePublicationError(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new Error("门户发布重试失败");
  });
}

export async function listPortalHistory(db: PortalDb, city: City, limit = 10) {
  const boundedLimit = Math.min(10, Math.max(1, Math.trunc(limit)));
  const records = await db.guidePortalPublication.findMany({
    where: { city },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    take: boundedLimit * 4,
  });
  const versions = new Map<number, typeof records>();
  for (const record of records) {
    const entries = versions.get(record.version) ?? [];
    entries.push(record);
    versions.set(record.version, entries);
  }
  return [...versions.entries()]
    .sort(([left], [right]) => right - left)
    .filter(([, entries]) =>
      entries.some(({ viewport }) => viewport === PortalViewport.DESKTOP)
      && entries.some(({ viewport }) => viewport === PortalViewport.MOBILE)
    )
    .slice(0, boundedLimit)
    .map(([version, entries]) => {
      const desktop = entries.find(({ viewport }) => viewport === PortalViewport.DESKTOP)!;
      const mobile = entries.find(({ viewport }) => viewport === PortalViewport.MOBILE)!;
      const createdAt = desktop.createdAt > mobile.createdAt ? desktop.createdAt : mobile.createdAt;
      return {
        version,
        createdAt,
        publishedBySnapshot: desktop.publishedBySnapshot,
        desktop: {
          id: desktop.id,
          scene: storedPublicationScene(desktop),
        },
        mobile: {
          id: mobile.id,
          scene: storedPublicationScene(mobile),
        },
      };
    });
}

export async function restorePortalPublication(
  db: PortalDb,
  city: City,
  viewport: PortalViewport,
  version: number,
  expectedRevision: number,
  actorId: string,
  hooks: Pick<
    PortalMutationHooks,
    "beforeRevisionMutationAttempt" | "afterDraftRevisionRead"
  > = {},
) {
  const saved = await runRevisionCheckedMutation(() =>
    db.$transaction(async (transaction) => {
      const source = await transaction.guidePortalPublication.findUnique({
        where: { city_viewport_version: { city, viewport, version } },
      });
      if (!source) throw new PortalServiceError("PUBLICATION_NOT_FOUND", "指定的门户发布版本不存在");
      const current = await transaction.guidePortalDraft.findUnique({
        where: { city_viewport: { city, viewport } },
      });
      if (current ? current.draftRevision !== expectedRevision : expectedRevision !== 0) {
        throw draftConflict();
      }
      const scene = storedPublicationScene(source);
      return writeSceneDraft(
        transaction,
        city,
        viewport,
        scene,
        expectedRevision,
        actorId,
        "PORTAL_PUBLICATION_RESTORE",
        { sourceVersion: version },
        hooks,
      );
    }),
    hooks.beforeRevisionMutationAttempt,
  );
  return sceneDraftResponse(saved);
}

export async function listPortalAssets(db: PortalDb, _city?: City) {
  void _city;
  const latestPublicationIds = (await Promise.all(
    Object.values(City).flatMap((city) =>
      Object.values(PortalViewport).map((viewport) =>
        db.guidePortalPublication.findFirst({
          where: { city, viewport },
          orderBy: [{ version: "desc" }, { createdAt: "desc" }],
          select: { id: true },
        })
      )
    ),
  )).flatMap((publication) => publication ? [publication.id] : []);
  const currentIds = new Set(latestPublicationIds);
  const assets = await db.fileAsset.findMany({
    where: { kind: FileAssetKind.PORTAL_IMAGE },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
      portalAssetMetadata: true,
      portalReferences: {
        select: {
          elementId: true,
          draft: { select: { city: true, viewport: true } },
          publication: { select: { id: true, city: true, viewport: true, version: true } },
        },
      },
    },
  });
  return assets.map(({ portalAssetMetadata, portalReferences, ...asset }) => {
    const draftReferences = portalReferences.flatMap((reference) =>
      reference.draft
        ? [{ ...reference.draft, elementId: reference.elementId }]
        : []
    );
    const currentReferences = portalReferences.flatMap((reference) =>
      reference.publication && currentIds.has(reference.publication.id)
        ? [{
            city: reference.publication.city,
            viewport: reference.publication.viewport,
            version: reference.publication.version,
            elementId: reference.elementId,
          }]
        : []
    );
    const historyReferences = portalReferences.flatMap((reference) =>
      reference.publication && !currentIds.has(reference.publication.id)
        ? [{
            city: reference.publication.city,
            viewport: reference.publication.viewport,
            version: reference.publication.version,
            elementId: reference.elementId,
          }]
        : []
    );
    const decodedCostBytes = portalAssetMetadata?.decodedCostBytes === null
      || portalAssetMetadata?.decodedCostBytes === undefined
      ? null
      : Number(portalAssetMetadata.decodedCostBytes);
    const category = portalAssetMetadata?.category ?? "UNCLASSIFIED";
    const width = portalAssetMetadata?.width ?? null;
    const height = portalAssetMetadata?.height ?? null;
    return {
      ...asset,
      category,
      width,
      height,
      frameCount: portalAssetMetadata?.frameCount ?? null,
      decodedCostBytes,
      inspectionStatus: portalAssetMetadata?.inspectionStatus ?? "LEGACY_UNINSPECTED",
      incompatibilityReason: portalAssetMetadata?.incompatibilityReason ?? null,
      inspectedAt: portalAssetMetadata?.inspectedAt ?? null,
      searchText: [
        asset.originalName,
        asset.mimeType,
        category,
        width === null || height === null ? "" : `${width}x${height}`,
      ].join(" ").toLocaleLowerCase("zh-CN"),
      references: {
        draft: draftReferences,
        current: currentReferences,
        history: historyReferences,
      },
      referenceCounts: {
        draft: draftReferences.length,
        current: currentReferences.length,
        history: historyReferences.length,
      },
      unused: portalReferences.length === 0,
      url: `/api/files/${encodeURIComponent(asset.id)}`,
    };
  });
}

export async function uploadPortalAsset(
  db: PortalDb,
  file: PortalImageInput,
  actorId: string,
  privateRoot = defaultPrivateRoot,
  hooks: Pick<PortalMutationHooks, "afterAssetFileWrite"> & {
    category?: "LOGO" | "BACKGROUND" | "OFFICE_MAP" | "IMAGE" | "ICON" | "ILLUSTRATION";
  } = {},
) {
  const inspection = inspectPortalImage(file);
  const category = hooks.category ?? "IMAGE";
  const extension = path.extname(file.fileName).toLowerCase();
  const storageKey = path.posix.join("portal", `${randomUUID()}${extension}`);
  await mkdir(path.resolve(privateRoot, "portal"), { recursive: true });
  const absolutePath = await resolvePrivateAssetPathSecure(storageKey, privateRoot, { allowMissingLeaf: true });
  if (!absolutePath) throw new Error("无法生成安全的门户素材路径");
  let fileCreated = false;
  try {
    const handle = await open(absolutePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    fileCreated = true;
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.afterAssetFileWrite?.(absolutePath);
    const asset = await db.$transaction(async (transaction) => {
      const snapshot = await actorSnapshot(transaction, actorId);
      const created = await transaction.fileAsset.create({
        data: {
          kind: FileAssetKind.PORTAL_IMAGE,
          storageKey,
          originalName: path.basename(file.fileName),
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          uploadedById: actorId,
          uploadedBySnapshot: snapshot,
          portalAssetMetadata: {
            create: {
              category,
              width: inspection.width,
              height: inspection.height,
              frameCount: inspection.frameCount,
              decodedCostBytes: BigInt(inspection.decodedCostBytes),
              inspectionStatus: "VALID",
              inspectedAt: new Date(),
            },
          },
        },
      });
      await writeAuditLog(transaction, {
        actorId,
        action: "PORTAL_ASSET_UPLOAD",
        targetType: "FILE_ASSET",
        targetId: created.id,
        result: "SUCCESS",
        metadata: { mimeType: created.mimeType, sizeBytes: created.sizeBytes },
      });
      return created;
    });
    return {
      id: asset.id,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      createdAt: asset.createdAt,
      category,
      width: inspection.width,
      height: inspection.height,
      frameCount: inspection.frameCount,
      decodedCostBytes: inspection.decodedCostBytes,
      inspectionStatus: "VALID",
      url: `/api/files/${encodeURIComponent(asset.id)}`,
    };
  } catch (error) {
    if (!fileCreated) throw error;
    try { await unlink(absolutePath); }
    catch { throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材写入失败且临时文件清理失败"); }
    throw error;
  }
}

export async function deletePortalAsset(
  db: PortalDb,
  assetId: string,
  actorId: string,
  privateRoot = defaultPrivateRoot,
  hooks: PortalMutationHooks = {},
) {
  await hooks.beforeDeleteTransaction?.();
  const asset = await db.fileAsset.findFirst({
    where: { id: assetId, kind: FileAssetKind.PORTAL_IMAGE },
    select: { storageKey: true, originalName: true },
  });
  if (!asset) throw new PortalServiceError("ASSET_NOT_FOUND", "门户素材不存在");
  if (await db.guidePortalAssetReference.count({ where: { assetId } }) > 0) {
    throw new PortalServiceError("ASSET_REFERENCED", "该素材仍被草稿或发布版本引用，不能删除");
  }

  const absolutePath = await resolvePrivateAssetPathSecure(asset.storageKey, privateRoot);
  if (!absolutePath) {
    await writeAuditLog(db, {
      actorId,
      action: "PORTAL_ASSET_CLEANUP",
      targetType: "FILE_ASSET",
      targetId: assetId,
      result: "FAILURE",
      metadata: { originalName: asset.originalName, phase: "QUARANTINE" },
    });
    throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材文件无法安全移入删除隔离区");
  }
  const quarantineDirectory = path.join(privateRoot, ".portal-delete-quarantine");
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  const quarantinePath = path.join(
    quarantineDirectory,
    `${randomUUID()}${path.extname(asset.originalName).toLowerCase()}`,
  );
  try {
    await rename(absolutePath, quarantinePath);
  } catch {
    await writeAuditLog(db, {
      actorId,
      action: "PORTAL_ASSET_CLEANUP",
      targetType: "FILE_ASSET",
      targetId: assetId,
      result: "FAILURE",
      metadata: { originalName: asset.originalName, phase: "QUARANTINE" },
    });
    throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材文件无法移入删除隔离区");
  }

  try {
    await db.$transaction(async (transaction) => {
      const found = await transaction.fileAsset.findFirst({ where: { id: assetId, kind: FileAssetKind.PORTAL_IMAGE }, select: { storageKey: true, originalName: true } });
      if (!found) throw new PortalServiceError("ASSET_NOT_FOUND", "门户素材不存在");
      if (found.storageKey !== asset.storageKey) throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材路径在删除期间发生变化");
      if (await transaction.guidePortalAssetReference.count({ where: { assetId } }) > 0) throw new PortalServiceError("ASSET_REFERENCED", "该素材仍被草稿或发布版本引用，不能删除");
      await hooks.afterDeleteReferenceCheck?.();
      await transaction.fileAsset.delete({ where: { id: assetId } });
    });
  } catch (error) {
    try {
      await rename(quarantinePath, absolutePath);
    } catch {
      await writeAuditLog(db, {
        actorId,
        action: "PORTAL_ASSET_CLEANUP",
        targetType: "FILE_ASSET",
        targetId: assetId,
        result: "FAILURE",
        metadata: {
          originalName: asset.originalName,
          phase: "RESTORE",
          quarantineKey: path.relative(privateRoot, quarantinePath),
        },
      });
      throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材删除失败且隔离文件无法恢复");
    }
    if (error instanceof PortalServiceError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "P2003") throw new PortalServiceError("ASSET_REFERENCED", "该素材在删除期间被布局引用，不能删除");
    throw error;
  }

  try {
    await hooks.beforeDeleteQuarantineCleanup?.(quarantinePath);
    await unlink(quarantinePath);
  } catch {
    await writeAuditLog(db, {
      actorId,
      action: "PORTAL_ASSET_CLEANUP",
      targetType: "FILE_ASSET",
      targetId: assetId,
      result: "FAILURE",
      metadata: {
        originalName: asset.originalName,
        phase: "DELETE_QUARANTINE",
        quarantineKey: path.relative(privateRoot, quarantinePath),
      },
    });
    throw new PortalServiceError("ASSET_CLEANUP_FAILED", "门户素材已隔离，但私有文件清理失败");
  }
  await writeAuditLog(db, {
    actorId,
    action: "PORTAL_ASSET_DELETE",
    targetType: "FILE_ASSET",
    targetId: assetId,
    result: "SUCCESS",
    metadata: { originalName: asset.originalName },
  });
}

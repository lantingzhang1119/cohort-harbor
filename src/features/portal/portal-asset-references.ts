import type { PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind } from "@/generated/prisma/enums";
import type { PortalSceneV1 } from "@/features/portal/portal-scene";

export const MAX_PORTAL_SCENE_BITMAP_BYTES = 256 * 1024 * 1024;

export type SceneAssetReference = {
  assetId: string;
  elementId: string;
};

export class PortalAssetReferenceError extends Error {
  constructor(
    public readonly code: "INVALID_ASSET_REFERENCE" | "SCENE_BITMAP_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "PortalAssetReferenceError";
  }
}

export function extractSceneAssetReferences(scene: PortalSceneV1): SceneAssetReference[] {
  if (scene.elements.some(({ id }) => id === "__background__")) {
    throw new PortalAssetReferenceError(
      "INVALID_ASSET_REFERENCE",
      "元素 ID __background__ 为门户背景引用保留",
    );
  }
  const references: SceneAssetReference[] = [];
  if (scene.background.assetId) {
    references.push({
      assetId: scene.background.assetId,
      elementId: "__background__",
    });
  }
  for (const element of scene.elements) {
    if (element.type === "IMAGE") {
      references.push({ assetId: element.assetId, elementId: element.id });
    }
  }

  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.assetId}\0${reference.elementId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function assertSceneBitmapBudget(
  db: Pick<PrismaClient, "fileAsset">,
  scene: PortalSceneV1,
  maxBytes = MAX_PORTAL_SCENE_BITMAP_BYTES,
) {
  const assetIds = [...new Set(extractSceneAssetReferences(scene).map(({ assetId }) => assetId))];
  if (assetIds.length === 0) return 0;

  const assets = await db.fileAsset.findMany({
    where: {
      id: { in: assetIds },
      kind: FileAssetKind.PORTAL_IMAGE,
    },
    select: {
      id: true,
      portalAssetMetadata: {
        select: {
          decodedCostBytes: true,
          width: true,
          height: true,
          inspectionStatus: true,
        },
      },
    },
  });
  if (
    assets.length !== assetIds.length
    || assets.some(({ portalAssetMetadata }) =>
      portalAssetMetadata?.inspectionStatus !== "VALID"
      || portalAssetMetadata.decodedCostBytes === null
      || portalAssetMetadata.decodedCostBytes < 0n
      || portalAssetMetadata.width === null
      || portalAssetMetadata.width <= 0
      || portalAssetMetadata.height === null
      || portalAssetMetadata.height <= 0
    )
  ) {
    throw new PortalAssetReferenceError(
      "INVALID_ASSET_REFERENCE",
      "场景引用的门户素材不存在、类型不正确或尚未通过安全检查",
    );
  }

  const total = assets.reduce(
    (sum, { portalAssetMetadata }) =>
      sum
      + BigInt(portalAssetMetadata!.width!)
      * BigInt(portalAssetMetadata!.height!)
      * 4n,
    0n,
  );
  if (total > BigInt(maxBytes)) {
    throw new PortalAssetReferenceError(
      "SCENE_BITMAP_BUDGET_EXCEEDED",
      "单个门户场景的唯一图片解码预算不能超过 256 MiB",
    );
  }
  return Number(total);
}

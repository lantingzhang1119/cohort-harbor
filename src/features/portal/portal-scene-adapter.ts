import { z } from "zod";

import {
  normalizePortalScene,
  type PortalImageElement,
  type PortalSceneV1,
  type PortalViewportInput,
} from "@/features/portal/portal-scene";

const viewportSchema = z.enum(["DESKTOP", "MOBILE"]);
const legacyElementSchema = z.object({
  id: z.string().trim().min(1).max(100),
  kind: z.enum(["LOGO", "IMAGE"]),
  assetId: z.string().trim().min(1).max(191),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  zIndex: z.number().finite(),
  altText: z.string().trim().min(1).max(300),
}).passthrough();

export type LegacyPortalElement = {
  id: string;
  kind: "IMAGE";
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  altText: string;
};

type StoredPortalSceneRecord = {
  viewport: PortalViewportInput | string;
  sceneVersion?: number | null;
  scene?: unknown;
  elements?: unknown;
};

export function parseStoredPortalScene(record: StoredPortalSceneRecord): PortalSceneV1 {
  const viewport = viewportSchema.parse(record.viewport);
  if (record.sceneVersion === 1) {
    return normalizePortalScene(viewport, record.scene);
  }
  if (record.sceneVersion !== undefined && record.sceneVersion !== null && record.sceneVersion !== 0) {
    throw new Error(`不支持的门户场景版本：${record.sceneVersion}`);
  }

  const legacyElements = z.array(legacyElementSchema).max(200).parse(record.elements ?? []);
  return normalizePortalScene(viewport, {
    sceneVersion: 1,
    viewport,
    requiresMobileReview: false,
    background: {
      assetId: null,
      fitMode: "COVER",
      positionX: 50,
      positionY: 50,
      backgroundColor: "#FFFFFF",
      locked: false,
    },
    elements: legacyElements.map((element) => ({
      id: element.id,
      name: element.altText.slice(0, 100),
      type: "IMAGE",
      assetId: element.assetId,
      altText: element.altText,
      fitMode: "CONTAIN",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      cornerRadius: 0,
      lockAspectRatio: true,
      action: null,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: 0,
      opacity: 1,
      zIndex: element.zIndex,
      locked: false,
      hidden: false,
    })),
  });
}

export function projectSceneToLegacyElements(scene: PortalSceneV1): LegacyPortalElement[] {
  return scene.elements
    .filter((element): element is PortalImageElement => element.type === "IMAGE" && !element.hidden)
    .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
    .map((element, zIndex) => ({
      id: element.id,
      kind: "IMAGE",
      assetId: element.assetId,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      zIndex,
      altText: element.altText,
    }));
}

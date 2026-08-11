import { z } from "zod";

import { PortalViewport } from "@/generated/prisma/enums";

export const PORTAL_CANVAS_SIZES = {
  DESKTOP: { canvasWidth: 1440, canvasHeight: 900 },
  MOBILE: { canvasWidth: 390, canvasHeight: 844 },
} as const satisfies Record<PortalViewport, { canvasWidth: number; canvasHeight: number }>;

export const PORTAL_MIN_ELEMENT_SIZE = 24;

export const portalElementSchema = z.object({
  id: z.string().trim().min(1).max(100),
  kind: z.enum(["LOGO", "IMAGE"]),
  assetId: z.string().trim().min(1).max(191),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().min(PORTAL_MIN_ELEMENT_SIZE),
  height: z.number().finite().min(PORTAL_MIN_ELEMENT_SIZE),
  zIndex: z.number().int().min(-10_000).max(10_000),
  altText: z.string().trim().min(1).max(300),
}).strict();

const portalElementSaveSchema = z.object({
  id: z.string().trim().min(1).max(100),
  kind: z.enum(["LOGO", "IMAGE"]),
  assetId: z.string().trim().min(1).max(191),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  zIndex: z.number().finite().min(-10_000).max(10_000),
  altText: z.string().trim().min(1).max(300),
}).strict();

export const portalDraftSaveSchema = z.object({
  viewport: z.enum([PortalViewport.DESKTOP, PortalViewport.MOBILE]),
  elements: z.array(portalElementSaveSchema).max(200),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, element] of value.elements.entries()) {
    if (ids.has(element.id)) {
      context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "元素 ID 不能重复" });
    }
    ids.add(element.id);
  }
});

export const portalViewportSchema = z.enum([PortalViewport.DESKTOP, PortalViewport.MOBILE]);

export type PortalElementInput = z.infer<typeof portalElementSchema>;
export type PortalElementSaveInput = z.infer<typeof portalElementSaveSchema>;
export type PortalDraftSaveInput = z.infer<typeof portalDraftSaveSchema>;

export function clampPortalElements(
  viewport: PortalViewport,
  input: unknown,
): PortalElementInput[] {
  const elements = z.array(portalElementSaveSchema).max(200).parse(input);
  const { canvasWidth, canvasHeight } = PORTAL_CANVAS_SIZES[viewport];
  const ids = new Set<string>();
  return elements.map((element) => {
    if (ids.has(element.id)) throw new Error("元素 ID 不能重复");
    ids.add(element.id);
    const width = Math.min(canvasWidth, Math.max(PORTAL_MIN_ELEMENT_SIZE, Math.round(element.width)));
    const height = Math.min(canvasHeight, Math.max(PORTAL_MIN_ELEMENT_SIZE, Math.round(element.height)));
    return portalElementSchema.parse({
      ...element,
      x: Math.min(canvasWidth - width, Math.max(0, Math.round(element.x))),
      y: Math.min(canvasHeight - height, Math.max(0, Math.round(element.y))),
      width,
      height,
      zIndex: Math.round(element.zIndex),
    });
  });
}

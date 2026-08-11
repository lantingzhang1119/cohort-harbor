import { z } from "zod";

import { safePortalActionSchema } from "@/features/portal/portal-actions";
import { elementBounds, portalSceneCanvasSize } from "@/features/portal/portal-geometry";
import { normalizeClosedShapeFillInput } from "@/features/portal/portal-shape-fill";

export type PortalViewportInput = "DESKTOP" | "MOBILE";
export type PortalElementType =
  | "TEXT"
  | "RECT"
  | "CIRCLE"
  | "ELLIPSE"
  | "ROUND_RECT"
  | "TRIANGLE"
  | "LINE"
  | "ARROW"
  | "FREEHAND"
  | "IMAGE"
  | "ICON"
  | "BUTTON"
  | "MARKER";

export const PORTAL_CANVAS_SIZES = {
  DESKTOP: { canvasWidth: 1_440, canvasHeight: 900 },
  MOBILE: { canvasWidth: 390, canvasHeight: 844 },
} as const satisfies Record<PortalViewportInput, { canvasWidth: number; canvasHeight: number }>;

export const PORTAL_MAX_ELEMENTS = 200;

export const PORTAL_ICON_NAMES = [
  "ArrowRight",
  "BookOpen",
  "BriefcaseBusiness",
  "Building2",
  "Bus",
  "Car",
  "CheckCircle2",
  "Clock",
  "Coffee",
  "Heart",
  "Home",
  "Hotel",
  "Info",
  "Landmark",
  "Mail",
  "MapPin",
  "Navigation",
  "Phone",
  "ShieldCheck",
  "Star",
  "Train",
  "Users",
  "Utensils",
  "Wifi",
] as const;

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "颜色必须是六位十六进制值");
const plainTextSchema = (maximum: number) => z.string().max(maximum).refine(
  (value) => !/[<>]/u.test(value),
  "文本不能包含 HTML 标记",
);
const elementIdSchema = z.string().trim().min(1).max(100);
const labelSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const finiteGeometrySchema = z.number().finite();
export const portalDashStyleSchema = z.enum(["SOLID", "DASHED", "DOTTED"]);
export const portalShadowSchema = z.object({
  color: hexColorSchema,
  opacity: finiteGeometrySchema.min(0).max(1),
  blur: finiteGeometrySchema.min(0).max(100),
  offsetX: finiteGeometrySchema.min(-200).max(200),
  offsetY: finiteGeometrySchema.min(-200).max(200),
}).strict();
export const portalBorderSchema = z.object({
  color: hexColorSchema,
  width: finiteGeometrySchema.min(0.5).max(100),
  dash: portalDashStyleSchema,
}).strict();

const elementBaseShape = {
  id: elementIdSchema,
  name: labelSchema(100),
  x: finiteGeometrySchema,
  y: finiteGeometrySchema,
  width: finiteGeometrySchema,
  height: finiteGeometrySchema,
  rotation: finiteGeometrySchema.min(-360).max(360),
  opacity: finiteGeometrySchema.min(0).max(1),
  zIndex: z.number().int().min(0).max(PORTAL_MAX_ELEMENTS - 1),
  locked: z.boolean(),
  hidden: z.boolean(),
} as const;

const strokeShape = {
  fillEnabled: z.boolean().default(true),
  fill: hexColorSchema.nullable(),
  lastFillColor: hexColorSchema.default("#DCEBFA"),
  stroke: hexColorSchema.nullable(),
  strokeWidth: finiteGeometrySchema.min(0).max(100),
  dash: portalDashStyleSchema.default("SOLID"),
  shadow: portalShadowSchema.nullable().default(null),
} as const;

const portalCanvasSchema = z.object({
  logicalWidth: finiteGeometrySchema.positive().max(1_440),
  logicalHeight: finiteGeometrySchema.positive().max(100_000),
}).strict();

const textStyleShape = {
  color: hexColorSchema,
  fontFamily: z.enum(["Noto Sans SC Variable"]),
  fontSize: finiteGeometrySchema.min(6).max(300),
  fontWeight: z.number().int().min(100).max(900).refine((value) => value % 100 === 0),
  lineHeight: finiteGeometrySchema.min(0.5).max(4),
  align: z.enum(["LEFT", "CENTER", "RIGHT"]),
} as const;

const safeOptionalActionSchema = safePortalActionSchema.nullable().default(null);

const cropSchema = z.object({
  x: finiteGeometrySchema.min(0).max(1),
  y: finiteGeometrySchema.min(0).max(1),
  width: finiteGeometrySchema.positive().max(1),
  height: finiteGeometrySchema.positive().max(1),
}).strict().superRefine((crop, context) => {
  if (crop.x + crop.width > 1) {
    context.addIssue({ code: "custom", path: ["width"], message: "图片裁剪不能超出源图宽度" });
  }
  if (crop.y + crop.height > 1) {
    context.addIssue({ code: "custom", path: ["height"], message: "图片裁剪不能超出源图高度" });
  }
});

const textElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("TEXT"),
  text: plainTextSchema(10_000),
  ...textStyleShape,
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  letterSpacing: finiteGeometrySchema.min(-5).max(50).default(0),
  backgroundColor: hexColorSchema.nullable().default(null),
  action: safeOptionalActionSchema,
}).strict();

const rectElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("RECT"),
  ...strokeShape,
}).strict();

const circleElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("CIRCLE"),
  ...strokeShape,
}).strict();

const ellipseElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("ELLIPSE"),
  ...strokeShape,
}).strict();

const roundRectElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("ROUND_RECT"),
  ...strokeShape,
  cornerRadius: finiteGeometrySchema.min(0).max(720),
}).strict();

const triangleElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("TRIANGLE"),
  ...strokeShape,
}).strict();

const lineElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("LINE"),
  stroke: hexColorSchema,
  strokeWidth: finiteGeometrySchema.positive().max(100),
  dash: portalDashStyleSchema.default("SOLID"),
  shadow: portalShadowSchema.nullable().default(null),
}).strict();

const arrowElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("ARROW"),
  stroke: hexColorSchema,
  strokeWidth: finiteGeometrySchema.positive().max(100),
  pointerLength: finiteGeometrySchema.positive().max(300),
  pointerWidth: finiteGeometrySchema.positive().max(300),
  dash: portalDashStyleSchema.default("SOLID"),
  shadow: portalShadowSchema.nullable().default(null),
}).strict();

/** Flat [x0,y0,x1,y1,...] path coordinates relative to the element origin. */
const freehandPointsSchema = z
  .array(finiteGeometrySchema)
  .min(4)
  .max(4_000)
  .refine((points) => points.length % 2 === 0, "自由绘制点必须成对出现")
  .refine(
    (points) => points.every((value) => Number.isFinite(value)),
    "自由绘制点必须是有限数值",
  );

const freehandElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("FREEHAND"),
  points: freehandPointsSchema,
  stroke: hexColorSchema,
  strokeWidth: finiteGeometrySchema.positive().max(100),
  tension: finiteGeometrySchema.min(0).max(1),
  lineCap: z.literal("ROUND"),
  lineJoin: z.literal("ROUND"),
}).strict();

const imageElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("IMAGE"),
  assetId: z.string().trim().min(1).max(191),
  altText: labelSchema(300),
  fitMode: z.enum(["CONTAIN", "COVER"]),
  crop: cropSchema,
  cornerRadius: finiteGeometrySchema.min(0).max(720).default(0),
  lockAspectRatio: z.boolean().optional(),
  action: safeOptionalActionSchema,
}).strict();

const iconElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("ICON"),
  iconName: z.enum(PORTAL_ICON_NAMES),
  color: hexColorSchema,
  action: safeOptionalActionSchema,
}).strict();

const buttonElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("BUTTON"),
  text: plainTextSchema(300).refine((value) => value.trim().length > 0, "按钮文本不能为空"),
  backgroundColor: hexColorSchema,
  cornerRadius: finiteGeometrySchema.min(0).max(720),
  action: safePortalActionSchema,
  ...textStyleShape,
  border: portalBorderSchema.nullable().default(null),
  shadow: portalShadowSchema.nullable().default(null),
}).strict();

const markerElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("MARKER"),
  text: plainTextSchema(300),
  color: hexColorSchema,
  backgroundColor: hexColorSchema,
  iconName: z.enum(PORTAL_ICON_NAMES).default("MapPin"),
  title: plainTextSchema(120)
    .refine((value) => value.trim().length > 0, "标记标题不能为空")
    .default("位置详情"),
  description: plainTextSchema(500)
    .refine((value) => value.trim().length > 0, "标记说明不能为空")
    .default("点击查看位置说明"),
}).strict();

const portalElementUnionSchema = z.discriminatedUnion("type", [
  textElementSchema,
  rectElementSchema,
  circleElementSchema,
  ellipseElementSchema,
  roundRectElementSchema,
  triangleElementSchema,
  lineElementSchema,
  arrowElementSchema,
  freehandElementSchema,
  imageElementSchema,
  iconElementSchema,
  buttonElementSchema,
  markerElementSchema,
]);

export const portalElementSchema = z.preprocess(
  normalizeClosedShapeFillInput,
  portalElementUnionSchema,
);

const portalBackgroundSchema = z.object({
  assetId: z.string().trim().min(1).max(191).nullable(),
  fitMode: z.enum(["CONTAIN", "COVER", "AUTO_HEIGHT"]),
  naturalWidth: z.number().int().positive().max(16_384).nullable().default(null),
  naturalHeight: z.number().int().positive().max(16_384).nullable().default(null),
  positionX: finiteGeometrySchema.min(0).max(100),
  positionY: finiteGeometrySchema.min(0).max(100),
  backgroundColor: hexColorSchema,
  locked: z.boolean(),
}).strict();

const portalSceneShape = z.object({
  sceneVersion: z.literal(1),
  viewport: z.enum(["DESKTOP", "MOBILE"]),
  requiresMobileReview: z.boolean(),
  background: portalBackgroundSchema,
  canvas: portalCanvasSchema,
  elements: z.array(portalElementSchema).max(PORTAL_MAX_ELEMENTS),
}).strict();

function normalizePortalSceneEnvelope(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const viewport = input.viewport === "MOBILE" ? "MOBILE" : "DESKTOP";
  const background = isRecord(input.background)
    ? { naturalWidth: null, naturalHeight: null, ...input.background }
    : input.background;
  const size = portalSceneCanvasSize({
    viewport,
    background: isRecord(background) ? background : null,
  });
  return {
    ...input,
    background,
    canvas: { logicalWidth: size.canvasWidth, logicalHeight: size.canvasHeight },
  };
}

export const portalSceneV1Schema = z.preprocess(
  normalizePortalSceneEnvelope,
  portalSceneShape,
).superRefine((scene, context) => {
  const ids = new Set<string>();
  const zIndexes = new Set<number>();
  const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = scene.canvas;

  if (
    scene.background.fitMode === "AUTO_HEIGHT"
    && (scene.background.assetId === null
      || scene.background.naturalWidth === null
      || scene.background.naturalHeight === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["background", "fitMode"],
      message: "长图完整显示需要带有效尺寸的背景图片",
    });
  }

  for (const [index, element] of scene.elements.entries()) {
    if (ids.has(element.id)) {
      context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "元素 ID 不能重复" });
    }
    ids.add(element.id);
    zIndexes.add(element.zIndex);

    if (element.width < 1 || element.width > canvasWidth || element.x < 0 || element.x + element.width > canvasWidth) {
      context.addIssue({ code: "custom", path: ["elements", index, "width"], message: "元素横向边界超出画布" });
    }
    if (element.height < 1 || element.height > canvasHeight || element.y < 0 || element.y + element.height > canvasHeight) {
      context.addIssue({ code: "custom", path: ["elements", index, "height"], message: "元素纵向边界超出画布" });
    }
    const renderedBounds = elementBounds(element);
    if (renderedBounds.x < -1e-9 || renderedBounds.x + renderedBounds.width > canvasWidth + 1e-9) {
      context.addIssue({ code: "custom", path: ["elements", index, "x"], message: "元素旋转后的横向边界超出画布" });
    }
    if (renderedBounds.y < -1e-9 || renderedBounds.y + renderedBounds.height > canvasHeight + 1e-9) {
      context.addIssue({ code: "custom", path: ["elements", index, "y"], message: "元素旋转后的纵向边界超出画布" });
    }
  }

  if (zIndexes.size !== scene.elements.length || [...zIndexes].some((value) => value >= scene.elements.length)) {
    context.addIssue({ code: "custom", path: ["elements"], message: "元素层级必须连续且唯一" });
  }
});

export type PortalElement = z.output<typeof portalElementSchema>;
export type PortalDashStyle = z.infer<typeof portalDashStyleSchema>;
export type PortalShadow = z.infer<typeof portalShadowSchema>;
export type PortalBorder = z.infer<typeof portalBorderSchema>;
export type PortalImageElement = Extract<PortalElement, { type: "IMAGE" }>;
export type PortalLineElement = Extract<PortalElement, { type: "LINE" | "ARROW" }>;
export type PortalFreehandElement = Extract<PortalElement, { type: "FREEHAND" }>;
export type PortalSceneV1 = {
  sceneVersion: 1;
  viewport: PortalViewportInput;
  requiresMobileReview: boolean;
  background: {
    assetId: string | null;
    fitMode: "CONTAIN" | "COVER" | "AUTO_HEIGHT";
    naturalWidth?: number | null;
    naturalHeight?: number | null;
    positionX: number;
    positionY: number;
    backgroundColor: string;
    locked: boolean;
  };
  canvas?: { logicalWidth: number; logicalHeight: number };
  elements: PortalElement[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeElementGeometry(
  element: Record<string, unknown>,
  canvas: { canvasWidth: number; canvasHeight: number },
): Record<string, unknown> {
  const { canvasWidth, canvasHeight } = canvas;
  if (
    typeof element.x !== "number"
    || typeof element.y !== "number"
    || typeof element.width !== "number"
    || typeof element.height !== "number"
    || typeof element.rotation !== "number"
    || typeof element.opacity !== "number"
    || ![element.x, element.y, element.width, element.height, element.rotation, element.opacity].every(Number.isFinite)
  ) {
    return element;
  }

  const width = clamp(element.width, 1, canvasWidth);
  const height = clamp(element.height, 1, canvasHeight);
  return {
    ...element,
    x: clamp(element.x, 0, canvasWidth - width),
    y: clamp(element.y, 0, canvasHeight - height),
    width,
    height,
    rotation: clamp(element.rotation, -360, 360),
    opacity: clamp(element.opacity, 0, 1),
  };
}

/** Uniform geometry scale used by fit/copy pipelines (points, strokes, fonts). */
export function scalePortalElementGeometry(element: PortalElement, scale: number): PortalElement {
  return scaleElementGeometry(element, scale);
}

function scaleElementGeometry(element: PortalElement, scale: number): PortalElement {
  const geometry = {
    width: Math.max(1, element.width * scale),
    height: Math.max(1, element.height * scale),
  };
  const shadow = (value: PortalShadow | null) => value === null ? null : {
    ...value,
    blur: value.blur * scale,
    offsetX: value.offsetX * scale,
    offsetY: value.offsetY * scale,
  };
  if (element.type === "LINE") {
    return {
      ...element,
      ...geometry,
      strokeWidth: element.strokeWidth * scale,
      shadow: shadow(element.shadow),
    };
  }
  if (element.type === "ARROW") {
    return {
      ...element,
      ...geometry,
      strokeWidth: element.strokeWidth * scale,
      pointerLength: element.pointerLength * scale,
      pointerWidth: element.pointerWidth * scale,
      shadow: shadow(element.shadow),
    };
  }
  if (element.type === "FREEHAND") {
    return {
      ...element,
      ...geometry,
      strokeWidth: element.strokeWidth * scale,
      points: element.points.map((value) => value * scale),
    };
  }
  if (
    element.type === "RECT"
    || element.type === "CIRCLE"
    || element.type === "ELLIPSE"
    || element.type === "ROUND_RECT"
    || element.type === "TRIANGLE"
  ) {
    return {
      ...element,
      ...geometry,
      strokeWidth: element.strokeWidth * scale,
      shadow: shadow(element.shadow),
      ...(element.type === "ROUND_RECT"
        ? { cornerRadius: element.cornerRadius * scale }
        : {}),
    };
  }
  if (element.type === "TEXT") {
    return {
      ...element,
      ...geometry,
      fontSize: Math.max(6, element.fontSize * scale),
      letterSpacing: element.letterSpacing * scale,
    };
  }
  if (element.type === "IMAGE") {
    return {
      ...element,
      ...geometry,
      cornerRadius: element.cornerRadius * scale,
    };
  }
  if (element.type === "BUTTON") {
    return {
      ...element,
      ...geometry,
      fontSize: Math.max(6, element.fontSize * scale),
      cornerRadius: element.cornerRadius * scale,
      border: element.border === null
        ? null
        : { ...element.border, width: Math.max(0.5, element.border.width * scale) },
      shadow: shadow(element.shadow),
    };
  }
  return { ...element, ...geometry };
}

function fitRenderedElementToCanvas(
  element: unknown,
  canvas: { canvasWidth: number; canvasHeight: number },
): unknown {
  const parsed = portalElementSchema.safeParse(element);
  if (!parsed.success) return element;

  const { canvasWidth, canvasHeight } = canvas;
  let fitted = parsed.data;
  let bounds = elementBounds(fitted);
  const scale = Math.min(1, canvasWidth / bounds.width, canvasHeight / bounds.height);
  if (scale < 1) {
    fitted = scaleElementGeometry(fitted, scale);
    bounds = elementBounds(fitted);
  }

  let x = fitted.x;
  let y = fitted.y;
  if (bounds.x < 0) x -= bounds.x;
  else if (bounds.x + bounds.width > canvasWidth) x -= bounds.x + bounds.width - canvasWidth;
  if (bounds.y < 0) y -= bounds.y;
  else if (bounds.y + bounds.height > canvasHeight) y -= bounds.y + bounds.height - canvasHeight;

  return { ...fitted, x, y };
}

export function normalizePortalScene(
  viewport: PortalViewportInput,
  input: unknown,
): PortalSceneV1 {
  if (!isRecord(input)) return portalSceneV1Schema.parse(input) as PortalSceneV1;

  const {
    canvasWidth: _ignoredCanvasWidth,
    canvasHeight: _ignoredCanvasHeight,
    ...sceneInput
  } = input;
  void _ignoredCanvasWidth;
  void _ignoredCanvasHeight;

  if (!Array.isArray(sceneInput.elements)) {
    return portalSceneV1Schema.parse({ ...sceneInput, viewport }) as PortalSceneV1;
  }

  const canvas = portalSceneCanvasSize({
    viewport,
    background: isRecord(sceneInput.background) ? sceneInput.background : null,
  });

  const geometryNormalized = sceneInput.elements.map((element) =>
    isRecord(element) ? normalizeElementGeometry(element, canvas) : element,
  );
  const ordering = geometryNormalized.map((element, index) => {
    if (!isRecord(element) || typeof element.zIndex !== "number" || !Number.isFinite(element.zIndex)) {
      return { index, id: "", zIndex: Number.NaN };
    }
    return {
      index,
      id: typeof element.id === "string" ? element.id : "",
      zIndex: element.zIndex,
    };
  });

  const hasValidOrdering = ordering.every(({ zIndex }) => Number.isFinite(zIndex));
  if (hasValidOrdering) {
    ordering.sort((left, right) =>
      left.zIndex - right.zIndex
      || left.id.localeCompare(right.id)
      || left.index - right.index,
    );
  }
  const normalizedZIndexes = hasValidOrdering
    ? new Map(ordering.map((element, zIndex) => [element.index, zIndex]))
    : new Map<number, number>();
  const elements = geometryNormalized.map((element, index) =>
    isRecord(element)
      ? normalizeClosedShapeFillInput({
          ...element,
          zIndex: normalizedZIndexes.get(index) ?? element.zIndex,
        })
      : element,
  ).map((element) => fitRenderedElementToCanvas(element, canvas));

  return portalSceneV1Schema.parse({
    ...sceneInput,
    viewport,
    background: isRecord(sceneInput.background)
      ? {
          ...sceneInput.background,
          positionX: typeof sceneInput.background.positionX === "number" && Number.isFinite(sceneInput.background.positionX)
            ? clamp(sceneInput.background.positionX, 0, 100)
            : sceneInput.background.positionX,
          positionY: typeof sceneInput.background.positionY === "number" && Number.isFinite(sceneInput.background.positionY)
            ? clamp(sceneInput.background.positionY, 0, 100)
            : sceneInput.background.positionY,
        }
      : sceneInput.background,
    elements,
  }) as PortalSceneV1;
}

export function defaultPortalScene(viewport: PortalViewportInput): PortalSceneV1 {
  return {
    sceneVersion: 1,
    viewport,
    requiresMobileReview: false,
    background: {
      assetId: null,
      fitMode: "COVER",
      naturalWidth: null,
      naturalHeight: null,
      positionX: 50,
      positionY: 50,
      backgroundColor: "#FFFFFF",
      locked: false,
    },
    canvas: {
      logicalWidth: PORTAL_CANVAS_SIZES[viewport].canvasWidth,
      logicalHeight: PORTAL_CANVAS_SIZES[viewport].canvasHeight,
    },
    elements: [],
  };
}

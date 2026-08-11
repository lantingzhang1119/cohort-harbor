import { describe, expect, it } from "vitest";

import { safePortalActionSchema } from "@/features/portal/portal-actions";
import {
  defaultPortalScene,
  normalizePortalScene,
  PORTAL_CANVAS_SIZES,
  portalElementSchema,
  portalSceneV1Schema,
} from "@/features/portal/portal-scene";
import { elementBounds } from "@/features/portal/portal-geometry";
import { createDefaultPortalElement } from "@/features/portal/editor/component-panel";
import { normalizeClosedShapeFillInput } from "@/features/portal/portal-shape-fill";

const baseElement = {
  id: "welcome",
  name: "欢迎语",
  x: 40,
  y: 60,
  width: 400,
  height: 120,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
} as const;

const desktopScene = {
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
  elements: [{
    ...baseElement,
    type: "TEXT",
    text: "欢迎加入CohortHarbor",
    color: "#123456",
    fontFamily: "Noto Sans SC Variable",
    fontSize: 48,
    fontWeight: 700,
    lineHeight: 1.4,
    align: "CENTER",
  }],
} as const;

const mobileScene = {
  ...desktopScene,
  viewport: "MOBILE",
  elements: [],
} as const;

describe("portal scene contract", () => {
  it("fills new field defaults when reading an old strict V1 scene", () => {
    expect(portalSceneV1Schema.parse(desktopScene)).toEqual({
      ...desktopScene,
      background: {
        ...desktopScene.background,
        naturalWidth: null,
        naturalHeight: null,
      },
      canvas: { logicalWidth: 1_440, logicalHeight: 900 },
      elements: [{
        ...desktopScene.elements[0],
        italic: false,
        underline: false,
        letterSpacing: 0,
        backgroundColor: null,
        action: null,
      }],
    });
  });

  it("rejects unknown fields, raw SVG and protocol-relative links", () => {
    expect(() => portalSceneV1Schema.parse({ ...desktopScene, rogue: true })).toThrow();
    expect(() => portalSceneV1Schema.parse({
      ...desktopScene,
      elements: [{ ...baseElement, type: "ICON", iconName: "MapPin", color: "#000000", svg: "<svg />" }],
    })).toThrow();
    expect(() => safePortalActionSchema.parse({ href: "//evil.test", target: "_blank" })).toThrow();
    expect(() => safePortalActionSchema.parse({ href: "https://u:p@example.invalid", target: "_self" })).toThrow();
  });

  it("derives dimensions from viewport and blocks invalid scene roots", () => {
    const scene = normalizePortalScene("MOBILE", { ...mobileScene, canvasWidth: 999 });
    expect(scene.viewport).toBe("MOBILE");
    expect(PORTAL_CANVAS_SIZES[scene.viewport]).toEqual({ canvasWidth: 390, canvasHeight: 844 });
    expect(() => normalizePortalScene("MOBILE", { ...mobileScene, rogue: true })).toThrow();
  });

  it("normalizes stacking and clamps finite geometry to the canonical canvas", () => {
    const scene = normalizePortalScene("MOBILE", {
      ...mobileScene,
      elements: [
        { ...baseElement, id: "top", name: "顶部", type: "RECT", x: -50, y: -40, width: 900, height: 900, rotation: 800, zIndex: 100, fill: "#FFFFFF", stroke: "#000000", strokeWidth: 0 },
        { ...baseElement, id: "bottom", name: "底部", type: "RECT", x: 300, y: 800, width: 120, height: 80, rotation: -800, zIndex: -100, fill: "#FFFFFF", stroke: "#000000", strokeWidth: 1 },
      ],
    });

    expect(scene.elements.map(({ id, zIndex }) => ({ id, zIndex }))).toEqual([
      { id: "top", zIndex: 1 },
      { id: "bottom", zIndex: 0 },
    ]);
    expect(scene.elements[0]).toMatchObject({ x: 0, y: 0, width: 390, height: 844, rotation: 360 });
    expect(scene.elements[1]).toMatchObject({ x: 269.5, y: 763.5, rotation: -360 });
  });

  it("keeps rotated rendered bounds inside the canonical canvas", () => {
    const scene = normalizePortalScene("MOBILE", {
      ...mobileScene,
      elements: [{
        ...baseElement,
        id: "rotated",
        type: "RECT",
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        rotation: 45,
        fill: "#FFFFFF",
        stroke: "#000000",
        strokeWidth: 1,
      }],
    });
    const bounds = elementBounds(scene.elements[0]);

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  });

  it("scales and translates a boundary-aligned stroked rectangle inside the canvas", () => {
    const boundaryScene = normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{
        ...baseElement,
        id: "boundary",
        type: "RECT",
        x: 0,
        y: 0,
        width: 1_440,
        height: 900,
        rotation: 0,
        fill: "#FFFFFF",
        stroke: "#000000",
        strokeWidth: 100,
      }],
    });
    const boundaryBounds = elementBounds(boundaryScene.elements[0]);
    expect(boundaryBounds.x).toBeGreaterThanOrEqual(0);
    expect(boundaryBounds.y).toBeGreaterThanOrEqual(0);
    expect(boundaryBounds.x + boundaryBounds.width).toBeLessThanOrEqual(1_440);
    expect(boundaryBounds.y + boundaryBounds.height).toBeLessThanOrEqual(900);
  });

  it("scales and translates a rotated stroked shape inside the canvas", () => {
    const rotatedScene = normalizePortalScene("MOBILE", {
      ...mobileScene,
      elements: [{
        ...baseElement,
        id: "rotated-stroke",
        type: "TRIANGLE",
        x: 0,
        y: 0,
        width: 380,
        height: 300,
        rotation: 37,
        fill: "#FFFFFF",
        stroke: "#000000",
        strokeWidth: 80,
      }],
    });
    const rotatedBounds = elementBounds(rotatedScene.elements[0]);
    expect(rotatedBounds.x).toBeGreaterThanOrEqual(0);
    expect(rotatedBounds.y).toBeGreaterThanOrEqual(0);
    expect(rotatedBounds.x + rotatedBounds.width).toBeLessThanOrEqual(390);
    expect(rotatedBounds.y + rotatedBounds.height).toBeLessThanOrEqual(844);
  });

  it("scales button border, radius and shadow with geometry when fitting rendered bounds", () => {
    const fitted = normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{
        ...baseElement,
        id: "shadow-button",
        type: "BUTTON",
        x: 0,
        y: 0,
        width: 1_440,
        height: 900,
        text: "查看",
        backgroundColor: "#112233",
        cornerRadius: 200,
        action: { href: "/", target: "_self" },
        color: "#FFFFFF",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 48,
        fontWeight: 700,
        lineHeight: 1.2,
        align: "CENTER",
        border: { color: "#FFFFFF", width: 100, dash: "DASHED" },
        shadow: { color: "#000000", opacity: 0.5, blur: 100, offsetX: 200, offsetY: 200 },
      }],
    });
    const button = fitted.elements[0] as Extract<typeof fitted.elements[number], { type: "BUTTON" }>;
    const bounds = elementBounds(button);

    expect(button.border?.width).toBeLessThan(100);
    expect(button.shadow?.blur).toBeLessThan(100);
    expect(button.cornerRadius).toBeLessThan(200);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1_440);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900 + 1e-9);
  });

  it("rejects duplicate IDs, non-finite geometry, HTML text and unlisted icons", () => {
    expect(() => normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [desktopScene.elements[0], { ...desktopScene.elements[0] }],
    })).toThrow();
    expect(() => normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{ ...desktopScene.elements[0], x: Number.NaN }],
    })).toThrow();
    expect(() => normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{ ...desktopScene.elements[0], zIndex: Number.NaN }],
    })).toThrow();
    expect(() => normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{ ...desktopScene.elements[0], text: "<b>欢迎</b>" }],
    })).toThrow();
    expect(() => normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{ ...baseElement, type: "ICON", iconName: "SkullAndCrossbones", color: "#000000" }],
    })).toThrow();
  });

  it("returns a strict empty default scene for each viewport", () => {
    expect(defaultPortalScene("DESKTOP")).toEqual({
      sceneVersion: 1,
      viewport: "DESKTOP",
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
      canvas: { logicalWidth: 1_440, logicalHeight: 900 },
      elements: [],
    });
    expect(portalSceneV1Schema.safeParse(defaultPortalScene("MOBILE")).success).toBe(true);
  });

  it("strictly round-trips all twelve rich element variants", () => {
    const richElements = [
      {
        ...baseElement,
        type: "TEXT",
        text: "欢迎",
        color: "#123456",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 30,
        fontWeight: 700,
        lineHeight: 1.4,
        align: "CENTER",
        italic: true,
        underline: true,
        letterSpacing: 3,
        backgroundColor: "#F0F9FF",
        action: { href: "/employee/guides", target: "_self" },
      },
      ...(["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const).map((type, index) => ({
        ...baseElement,
        id: type.toLowerCase(),
        type,
        zIndex: index + 1,
        fill: "#FFFFFF",
        stroke: "#112233",
        strokeWidth: 4,
        dash: "DASHED",
        shadow: { color: "#000000", opacity: 0.35, blur: 10, offsetX: 4, offsetY: 6 },
        ...(type === "ROUND_RECT" ? { cornerRadius: 20 } : {}),
      })),
      {
        ...baseElement,
        id: "line",
        type: "LINE",
        zIndex: 6,
        stroke: "#112233",
        strokeWidth: 4,
        dash: "DOTTED",
        shadow: { color: "#000000", opacity: 0.2, blur: 8, offsetX: -3, offsetY: 5 },
      },
      {
        ...baseElement,
        id: "arrow",
        type: "ARROW",
        zIndex: 7,
        stroke: "#112233",
        strokeWidth: 4,
        pointerLength: 18,
        pointerWidth: 16,
        dash: "DASHED",
        shadow: { color: "#000000", opacity: 0.25, blur: 6, offsetX: 2, offsetY: 2 },
      },
      {
        ...baseElement,
        id: "image",
        type: "IMAGE",
        zIndex: 8,
        assetId: "asset-image",
        altText: "办公室",
        fitMode: "COVER",
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        cornerRadius: 24,
        action: { href: "https://example.com/office", target: "_blank" },
      },
      {
        ...baseElement,
        id: "icon",
        type: "ICON",
        zIndex: 9,
        iconName: "MapPin",
        color: "#112233",
        action: { href: "/employee/guides", target: "_self" },
      },
      {
        ...baseElement,
        id: "button",
        type: "BUTTON",
        zIndex: 10,
        text: "查看",
        backgroundColor: "#112233",
        cornerRadius: 12,
        action: { href: "/employee/guides", target: "_self" },
        color: "#FFFFFF",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 18,
        fontWeight: 600,
        lineHeight: 1.2,
        align: "CENTER",
        border: { color: "#FFFFFF", width: 2, dash: "SOLID" },
        shadow: { color: "#000000", opacity: 0.3, blur: 12, offsetX: 0, offsetY: 6 },
      },
      {
        ...baseElement,
        id: "marker",
        type: "MARKER",
        zIndex: 11,
        text: "A",
        color: "#FFFFFF",
        backgroundColor: "#C2410C",
        iconName: "MapPin",
        title: "上海办公室",
        description: "点击查看位置说明",
      },
    ];
    const parsed = portalSceneV1Schema.parse({ ...desktopScene, elements: richElements });

    expect(portalSceneV1Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.elements).toHaveLength(12);
  });

  it("keeps enriched fields bounded and safe", () => {
    const text = portalSceneV1Schema.parse(desktopScene).elements[0];
    expect(portalElementSchema.safeParse({ ...text, letterSpacing: 51 }).success).toBe(false);
    expect(portalElementSchema.safeParse({
      ...text,
      action: { href: "javascript:alert(1)", target: "_self" },
    }).success).toBe(false);

    const shape = {
      ...baseElement,
      type: "RECT",
      fill: "#FFFFFF",
      stroke: "#000000",
      strokeWidth: 2,
    };
    expect(portalElementSchema.safeParse({
      ...shape,
      shadow: { color: "#000000", opacity: 1, blur: 101, offsetX: 0, offsetY: 0 },
    }).success).toBe(false);
    expect(portalElementSchema.safeParse({ ...shape, dash: "CUSTOM" }).success).toBe(false);
  });

  it("creates strict defaults for every element type", () => {
    const types = [
      "TEXT", "RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE",
      "LINE", "ARROW", "IMAGE", "ICON", "BUTTON", "MARKER",
    ] as const;
    for (const type of types) {
      expect(portalElementSchema.parse(
        createDefaultPortalElement(type, "DESKTOP", { x: 500, y: 400 }, "asset-image"),
      ).type).toBe(type);
    }
  });

  it("defaults old closed shapes to fillEnabled true without changing fill color", () => {
    for (const type of ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const) {
      const parsed = portalElementSchema.parse(normalizeClosedShapeFillInput({
        ...baseElement,
        id: type.toLowerCase(),
        type,
        fill: "#AABBCC",
        stroke: "#112233",
        strokeWidth: 2,
        ...(type === "ROUND_RECT" ? { cornerRadius: 12 } : {}),
      }));
      expect(parsed).toMatchObject({
        type,
        fillEnabled: true,
        fill: "#AABBCC",
        lastFillColor: "#AABBCC",
        stroke: "#112233",
        strokeWidth: 2,
      });
    }
  });

  it("persists fillEnabled false with fill null and lastFillColor for closed shapes", () => {
    for (const type of ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const) {
      const input = {
        ...baseElement,
        id: `hollow-${type.toLowerCase()}`,
        type,
        fillEnabled: false,
        fill: null,
        lastFillColor: "#DCEBFA",
        stroke: "#1E88E5",
        strokeWidth: 2,
        dash: "SOLID",
        shadow: null,
        ...(type === "ROUND_RECT" ? { cornerRadius: 12 } : {}),
      };
      const parsed = portalElementSchema.parse(input);
      const roundTrip = portalElementSchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(parsed).toMatchObject({
        type,
        fillEnabled: false,
        fill: null,
        lastFillColor: "#DCEBFA",
        stroke: "#1E88E5",
        strokeWidth: 2,
        opacity: 1,
      });
      expect(roundTrip).toEqual(parsed);
      expect(parsed).toMatchObject({ fill: null });
      expect(parsed.opacity).toBe(1);
    }
  });

  it("seeds new closed shapes with fill enabled and lastFillColor matching fill", () => {
    for (const type of ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const) {
      const element = createDefaultPortalElement(type, "DESKTOP", { x: 500, y: 400 }, "asset-image");
      const parsed = portalElementSchema.parse(element);
      expect(parsed).toMatchObject({
        type,
        fillEnabled: true,
        fill: "#DCEBFA",
        lastFillColor: "#DCEBFA",
        stroke: "#2563A7",
        strokeWidth: 2,
      });
    }
  });

  it("normalizes legacy draft JSON so missing fillEnabled becomes true before save", () => {
    const scene = normalizePortalScene("DESKTOP", {
      ...desktopScene,
      elements: [{
        ...baseElement,
        type: "TRIANGLE",
        fill: "#DCEBFA",
        stroke: "#1E88E5",
        strokeWidth: 2,
      }],
    });
    expect(scene.elements[0]).toMatchObject({
      type: "TRIANGLE",
      fillEnabled: true,
      fill: "#DCEBFA",
      lastFillColor: "#DCEBFA",
      stroke: "#1E88E5",
    });
  });

  it("preserves the original legacy fill as lastFillColor through direct schema parsing", () => {
    const parsed = portalElementSchema.parse({
      ...baseElement,
      type: "RECT",
      fill: "#A1B2C3",
      stroke: "#1E88E5",
      strokeWidth: 2,
    });

    expect(parsed).toMatchObject({
      fillEnabled: true,
      fill: "#A1B2C3",
      lastFillColor: "#A1B2C3",
    });
  });
});

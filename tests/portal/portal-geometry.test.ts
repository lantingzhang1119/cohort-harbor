import { describe, expect, it } from "vitest";

import {
  arrowGeometry,
  effectiveCornerRadius,
  elementBounds,
  imageRenderGeometry,
  portalCanvasSize,
  portalDashPattern,
  portalShadowFootprint,
  publishedScale,
} from "@/features/portal/portal-geometry";
import type { PortalElement } from "@/features/portal/portal-scene";

const arrow: PortalElement = {
  id: "route",
  name: "路线",
  type: "ARROW",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  stroke: "#112233",
  strokeWidth: 4,
  pointerLength: 12,
  pointerWidth: 10,
  dash: "SOLID",
  shadow: null,
};

const rect: PortalElement = {
  id: "box",
  name: "方框",
  type: "RECT",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  fillEnabled: true,
  fill: "#FFFFFF",
  lastFillColor: "#FFFFFF",
  stroke: "#112233",
  strokeWidth: 4,
  dash: "SOLID",
  shadow: null,
};

describe("portal canonical geometry", () => {
  it("uses the server-owned canvas sizes and never upscales publications", () => {
    expect(portalCanvasSize("DESKTOP")).toEqual({ canvasWidth: 1440, canvasHeight: 900 });
    expect(portalCanvasSize("MOBILE")).toEqual({ canvasWidth: 390, canvasHeight: 844 });
    expect(publishedScale(720, "DESKTOP")).toEqual({ scale: 0.5, renderedHeight: 450 });
    expect(publishedScale(2_000, "DESKTOP")).toEqual({ scale: 1, renderedHeight: 900 });
    expect(publishedScale(-10, "MOBILE")).toEqual({ scale: 0, renderedHeight: 0 });
  });

  it("calculates a center-rotated axis-aligned element bound", () => {
    expect(elementBounds(rect)).toEqual({ x: 8, y: 18, width: 104, height: 54 });
    expect(elementBounds({ ...rect, width: 100, height: 20, rotation: 90 })).toEqual({
      x: 48,
      y: -22,
      width: 24,
      height: 104,
    });
  });

  it("includes arrowhead and stroke footprint in rendered bounds", () => {
    const horizontal = { ...arrow, x: 0, y: 20, width: 100, height: 1, pointerWidth: 20 };
    const bounds = elementBounds(horizontal);

    expect(bounds.x).toBeLessThan(horizontal.x);
    expect(bounds.y).toBeLessThan(horizontal.y);
    expect(bounds.width).toBeGreaterThan(horizontal.width);
    expect(bounds.height).toBeGreaterThan(horizontal.height);
  });

  it("derives line and arrow points from the shared design bounds", () => {
    expect(arrowGeometry(arrow)).toEqual({
      points: [0, 0, 100, 50],
      start: { x: 10, y: 20 },
      end: { x: 110, y: 70 },
      pointerLength: 12,
      pointerWidth: 10,
    });
  });

  it("shares dash, effective radius and shadow footprint semantics", () => {
    expect(portalDashPattern("SOLID", 4)).toEqual([]);
    expect(portalDashPattern("DASHED", 4)).toEqual([16, 12]);
    expect(portalDashPattern("DOTTED", 4)).toEqual([4, 8]);
    expect(effectiveCornerRadius({
      ...rect,
      type: "ROUND_RECT",
      cornerRadius: 999,
    })).toBe(25);
    expect(portalShadowFootprint({
      color: "#000000",
      opacity: 0.5,
      blur: 10,
      offsetX: -4,
      offsetY: 6,
    })).toEqual({ left: 14, right: 6, top: 4, bottom: 16 });
  });

  it("shares image contain and cover crop geometry with non-Konva renderers", () => {
    const image = {
      ...rect,
      type: "IMAGE" as const,
      assetId: "floor-plan",
      altText: "楼层图",
      fitMode: "CONTAIN" as const,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      cornerRadius: 0,
      action: null,
    };

    expect(imageRenderGeometry(image, { naturalWidth: 400, naturalHeight: 200 })).toEqual({
      x: 25,
      y: 0,
      width: 50,
      height: 50,
      crop: { x: 100, y: 0, width: 200, height: 200 },
    });
    expect(imageRenderGeometry(
      { ...image, fitMode: "COVER" },
      { naturalWidth: 400, naturalHeight: 200 },
    )).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      crop: { x: 100, y: 50, width: 200, height: 100 },
    });
  });

  it("includes rotated shadow and button border in the rendered union", () => {
    const shadowed = elementBounds({
      ...rect,
      rotation: 90,
      shadow: {
        color: "#000000",
        opacity: 0.5,
        blur: 10,
        offsetX: 8,
        offsetY: -4,
      },
    });
    const plain = elementBounds({ ...rect, rotation: 90 });
    expect(shadowed.x).toBeLessThan(plain.x);
    expect(shadowed.y).toBeLessThan(plain.y);
    expect(shadowed.width).toBeGreaterThan(plain.width);
    expect(shadowed.height).toBeGreaterThan(plain.height);

    const button = elementBounds({
      ...rect,
      type: "BUTTON",
      text: "查看",
      backgroundColor: "#112233",
      cornerRadius: 8,
      action: { href: "/", target: "_self" },
      color: "#FFFFFF",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 18,
      fontWeight: 600,
      lineHeight: 1.2,
      align: "CENTER",
      border: { color: "#FFFFFF", width: 8, dash: "DASHED" },
      shadow: null,
    });
    expect(button).toEqual({ x: 6, y: 16, width: 108, height: 58 });
  });
});

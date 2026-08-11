import { describe, expect, it } from "vitest";

import {
  arrowGeometry,
  elementBounds,
  portalCanvasSize,
  publishedScale,
} from "@/features/portal/portal-geometry";
import type { PortalElement } from "@/features/portal/portal-scene";

const deterministicArrow: PortalElement = {
  id: "route-arrow",
  name: "路线箭头",
  type: "ARROW",
  x: 120,
  y: 180,
  width: 240,
  height: 40,
  rotation: 0,
  opacity: 1,
  zIndex: 3,
  locked: false,
  hidden: false,
  stroke: "#1D4ED8",
  strokeWidth: 4,
  pointerLength: 18,
  pointerWidth: 16,
  dash: "SOLID",
  shadow: null,
};

const deterministicRect: PortalElement = {
  id: "zone-rect",
  name: "工位区",
  type: "RECT",
  x: 80,
  y: 100,
  width: 200,
  height: 120,
  rotation: 0,
  opacity: 0.9,
  zIndex: 1,
  locked: false,
  hidden: false,
  fillEnabled: true,
  fill: "#DBEAFE",
  lastFillColor: "#DBEAFE",
  stroke: "#1E40AF",
  strokeWidth: 2,
  dash: "SOLID",
  shadow: null,
};

describe("portal geometry parity contract", () => {
  it("keeps arrow endpoints deterministic within 1 CSS px under published scales", () => {
    const geometry = arrowGeometry(deterministicArrow);
    const desktop = portalCanvasSize("DESKTOP");
    const mobile = portalCanvasSize("MOBILE");
    const desktopScale = publishedScale(desktop.canvasWidth, "DESKTOP").scale;
    const mobileScale = publishedScale(mobile.canvasWidth, "MOBILE").scale;
    const dpr1Scale = publishedScale(720, "DESKTOP").scale;
    const dpr2Container = publishedScale(720, "DESKTOP").scale;

    expect(desktopScale).toBe(1);
    expect(mobileScale).toBe(1);
    expect(dpr1Scale).toBe(0.5);
    expect(dpr2Container).toBe(0.5);

    for (const scale of [1, 0.5, 2]) {
      const startX = geometry.start.x * scale;
      const startY = geometry.start.y * scale;
      const endX = geometry.end.x * scale;
      const endY = geometry.end.y * scale;
      expect(Math.abs(startX - 120 * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(startY - 180 * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(endX - 360 * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(endY - 220 * scale)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps axis-aligned element bounds stable between design and half-scale CSS pixels", () => {
    const bounds = elementBounds(deterministicRect);
    // strokeWidth 2 expands the axis-aligned box by 1 CSS px on each side.
    expect(bounds).toEqual({ x: 79, y: 99, width: 202, height: 122 });
    const half = {
      x: bounds.x * 0.5,
      y: bounds.y * 0.5,
      width: bounds.width * 0.5,
      height: bounds.height * 0.5,
    };
    expect(Math.abs(half.x - 39.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(half.y - 49.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(half.width - 101)).toBeLessThanOrEqual(1);
    expect(Math.abs(half.height - 61)).toBeLessThanOrEqual(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  appendFreehandPoint,
  buildFreehandElementFromStroke,
  scaleFreehandElementGeometry,
  shouldAppendFreehandPoint,
} from "@/features/portal/editor/freehand-drawing";
import { elementBounds } from "@/features/portal/portal-geometry";
import {
  defaultPortalScene,
  normalizePortalScene,
  portalSceneV1Schema,
  scalePortalElementGeometry,
  type PortalElement,
} from "@/features/portal/portal-scene";

const freehand = {
  id: "freehand-1",
  name: "自由绘制",
  type: "FREEHAND",
  x: 100,
  y: 200,
  width: 160,
  height: 90,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  points: [0, 20, 40, 0, 90, 70, 160, 90],
  stroke: "#1E88E5",
  strokeWidth: 4,
  tension: 0.4,
  lineCap: "ROUND",
  lineJoin: "ROUND",
} as const satisfies Extract<PortalElement, { type: "FREEHAND" }>;

describe("portal freehand vector contract", () => {
  it("accepts and round-trips a bounded vector path", () => {
    const parsed = portalSceneV1Schema.parse({
      ...defaultPortalScene("DESKTOP"),
      elements: [freehand],
    });

    expect(parsed.elements[0]).toMatchObject(freehand);
    expect(portalSceneV1Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("uses the path stroke when calculating its rendered bounds", () => {
    const scene = portalSceneV1Schema.parse({
      ...defaultPortalScene("DESKTOP"),
      elements: [freehand],
    });
    const bounds = elementBounds(scene.elements[0]!);

    expect(bounds.x).toBe(98);
    expect(bounds.y).toBe(198);
    expect(bounds.width).toBe(164);
    expect(bounds.height).toBe(94);
  });

  it("rejects malformed or unbounded path point arrays", () => {
    for (const points of [[0, 0, 10], [0, 0, Number.NaN, 10], Array.from({ length: 4_002 }, (_, index) => index)]) {
      expect(() => portalSceneV1Schema.parse({
        ...defaultPortalScene("DESKTOP"),
        elements: [{ ...freehand, points }],
      })).toThrow();
    }
  });
});

describe("freehand stroke construction", () => {
  it("samples distant points and drops micro jitter", () => {
    expect(shouldAppendFreehandPoint([{ x: 0, y: 0 }], { x: 0.5, y: 0 })).toBe(false);
    expect(shouldAppendFreehandPoint([{ x: 0, y: 0 }], { x: 2, y: 0 })).toBe(true);
    expect(appendFreehandPoint([{ x: 0, y: 0 }], { x: 0.2, y: 0 })).toEqual([{ x: 0, y: 0 }]);
    expect(appendFreehandPoint([{ x: 0, y: 0 }], { x: 3, y: 4 })).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ]);
  });

  it("builds a FREEHAND element with relative points and round stroke style", () => {
    const element = buildFreehandElementFromStroke(
      [
        { x: 100, y: 120 },
        { x: 140, y: 150 },
        { x: 180, y: 130 },
      ],
      {
        canvasWidth: 1_440,
        canvasHeight: 900,
        zIndex: 0,
        stroke: "#112233",
        strokeWidth: 6,
        tension: 0.5,
        opacity: 0.8,
      },
    );

    expect(element).toMatchObject({
      type: "FREEHAND",
      name: "自由绘制",
      x: 100,
      y: 120,
      width: 80,
      height: 30,
      zIndex: 0,
      stroke: "#112233",
      strokeWidth: 6,
      tension: 0.5,
      opacity: 0.8,
      lineCap: "ROUND",
      lineJoin: "ROUND",
      locked: false,
      hidden: false,
    });
    expect(element!.points).toEqual([0, 0, 40, 30, 80, 10]);
    expect(portalSceneV1Schema.parse({
      ...defaultPortalScene("DESKTOP"),
      elements: [element!],
    }).elements[0]!.type).toBe("FREEHAND");
  });

  it("rejects strokes shorter than two samples", () => {
    expect(buildFreehandElementFromStroke([{ x: 10, y: 10 }], {
      canvasWidth: 1_440,
      canvasHeight: 900,
      zIndex: 0,
    })).toBeNull();
  });

  it("preserves edge stroke path shape and stays schema-valid", () => {
    const element = buildFreehandElementFromStroke(
      [
        { x: 0, y: 100 },
        { x: 50, y: 120 },
        { x: 80, y: 90 },
      ],
      {
        canvasWidth: 1_440,
        canvasHeight: 900,
        zIndex: 0,
        strokeWidth: 4,
      },
    );

    expect(element).not.toBeNull();
    // Relative geometry must not be crushed by stroke-padding box shifts.
    expect(element!.points).toEqual([0, 10, 50, 30, 80, 0]);
    expect(element!.width).toBe(80);
    expect(element!.height).toBe(30);
    const bounds = elementBounds(element!);
    expect(bounds.x).toBeGreaterThanOrEqual(-1e-9);
    expect(bounds.y).toBeGreaterThanOrEqual(-1e-9);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1_440 + 1e-9);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900 + 1e-9);
    expect(portalSceneV1Schema.parse({
      ...defaultPortalScene("DESKTOP"),
      elements: [element!],
    }).elements[0]!.type).toBe("FREEHAND");
  });

  it("does not collapse thick corner strokes into a zero-length path", () => {
    const element = buildFreehandElementFromStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
      ],
      {
        canvasWidth: 1_440,
        canvasHeight: 900,
        zIndex: 0,
        strokeWidth: 40,
      },
    );

    expect(element).not.toBeNull();
    expect(element!.points[0]).toBeCloseTo(0, 8);
    expect(element!.points[2]).toBeCloseTo(40, 8);
    expect(element!.points[0]).not.toEqual(element!.points[2]);
    expect(portalSceneV1Schema.safeParse({
      ...defaultPortalScene("DESKTOP"),
      elements: [element!],
    }).success).toBe(true);
  });

  it("respects long auto-height canvas bounds instead of fixed 900px height", () => {
    const element = buildFreehandElementFromStroke(
      [
        { x: 20, y: 5_000 },
        { x: 80, y: 5_040 },
      ],
      {
        canvasWidth: 1_440,
        canvasHeight: 5_643,
        zIndex: 1,
      },
    );

    expect(element).not.toBeNull();
    expect(element!.y).toBeGreaterThan(4_900);
    expect(element!.y + element!.height).toBeLessThanOrEqual(5_643);
  });
});

describe("freehand geometry transform and viewport copy", () => {
  it("scales path points with width/height changes", () => {
    const scaled = scaleFreehandElementGeometry(freehand, {
      x: 50,
      y: 60,
      width: 320,
      height: 180,
      rotation: 15,
    });

    expect(scaled).toMatchObject({
      x: 50,
      y: 60,
      width: 320,
      height: 180,
      rotation: 15,
      points: [0, 40, 80, 0, 180, 140, 320, 180],
      strokeWidth: 4,
    });
  });

  it("keeps freehand paths valid after scene normalization and resize", () => {
    const resized = scaleFreehandElementGeometry(freehand, {
      x: freehand.x,
      y: freehand.y,
      width: freehand.width * 2,
      height: freehand.height * 2,
      rotation: freehand.rotation,
    });
    const scene = normalizePortalScene("DESKTOP", {
      ...defaultPortalScene("DESKTOP"),
      elements: [resized],
    });
    const element = scene.elements[0] as Extract<PortalElement, { type: "FREEHAND" }>;
    expect(element.type).toBe("FREEHAND");
    expect(element.points.every(Number.isFinite)).toBe(true);
    expect(element.points.length % 2).toBe(0);
  });

  it("scales freehand points and stroke uniformly for desktop→mobile copy proportions", () => {
    const scale = 390 / 1_440;
    const mobile = scalePortalElementGeometry(freehand, scale) as
      Extract<PortalElement, { type: "FREEHAND" }>;
    expect(mobile.type).toBe("FREEHAND");
    expect(mobile.width).toBeCloseTo(freehand.width * scale, 5);
    expect(mobile.height).toBeCloseTo(freehand.height * scale, 5);
    expect(mobile.strokeWidth).toBeCloseTo(freehand.strokeWidth * scale, 5);
    expect(mobile.points[0]).toBeCloseTo(0, 5);
    expect(mobile.points[2]).toBeCloseTo(40 * scale, 5);
    expect(mobile.points[7]).toBeCloseTo(90 * scale, 5);
  });
});

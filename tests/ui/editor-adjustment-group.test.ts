import { describe, expect, it } from "vitest";

import {
  ADJUSTMENT_CHROME,
  adjustmentGroupCssSize,
  clampAdjustmentGroupCssPosition,
} from "@/features/portal/editor/editor-stage";
import { stepZoomToAdjacentTenPercent } from "@/features/portal/editor/editor-toolbar";

describe("adjustment group zoom-independent chrome", () => {
  it("uses fixed CSS chrome metrics (gap/padding/border/radius/button)", () => {
    expect(ADJUSTMENT_CHROME).toMatchObject({
      buttonSize: 30,
      gap: 4,
      padding: 4,
      border: 1,
      radius: 6,
      count: 6,
    });
    // 4+4 padding + 1+1 border + 6*30 buttons + 5*4 gaps = 210 × 40
    expect(adjustmentGroupCssSize()).toEqual({ width: 210, height: 40 });
  });

  it.each([0.1, 0.5, 1, 4] as const)(
    "places the 6-button strip in host CSS pixels at zoom %s without negative coords",
    (zoom) => {
      const canvas = { width: 1_440, height: 900 };
      const size = adjustmentGroupCssSize();
      const nearCorner = clampAdjustmentGroupCssPosition(
        { x: 1_400, y: 850, height: 40 },
        canvas,
        zoom,
      );
      expect(nearCorner.left).toBeGreaterThanOrEqual(0);
      expect(nearCorner.top).toBeGreaterThanOrEqual(0);
      expect(nearCorner.width).toBe(size.width);
      expect(nearCorner.height).toBe(size.height);
      // Host is design×zoom; when the strip is wider than the host (zoom 0.1 → 144 CSS),
      // left pins to 0 and the host must use overflow:visible so buttons stay unclipped.
      if (size.width <= canvas.width * zoom) {
        expect(nearCorner.left + size.width).toBeLessThanOrEqual(canvas.width * zoom + 1e-6);
      } else {
        expect(nearCorner.left).toBe(0);
      }
    },
  );
});

describe("toolbar 10% grid zoom steps", () => {
  it("floors shrink and ceils enlarge onto the adjacent 10% grid", () => {
    expect(stepZoomToAdjacentTenPercent(0.72, -1)).toBeCloseTo(0.7, 5);
    expect(stepZoomToAdjacentTenPercent(0.7, -1)).toBeCloseTo(0.6, 5);
    expect(stepZoomToAdjacentTenPercent(0.76, 1)).toBeCloseTo(0.8, 5);
    expect(stepZoomToAdjacentTenPercent(0.8, 1)).toBeCloseTo(0.9, 5);
    expect(stepZoomToAdjacentTenPercent(0.5, 1)).toBeCloseTo(0.6, 5);
    let zoom = 0.72;
    const sequence: number[] = [zoom];
    for (let i = 0; i < 6 && Math.round(zoom * 100) !== 100; i += 1) {
      zoom = stepZoomToAdjacentTenPercent(zoom, 1);
      sequence.push(zoom);
    }
    expect(sequence.map((value) => Math.round(value * 100))).toEqual([72, 80, 90, 100]);
  });
});

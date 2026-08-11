import { describe, expect, it } from "vitest";

import {
  closedShapeFillStyle,
  resolveClosedShapeFill,
} from "@/features/portal/portal-shape-fill";

describe("closed shape fill helpers", () => {
  it("uses fill color only when fill is enabled", () => {
    expect(resolveClosedShapeFill({
      fillEnabled: true,
      fill: "#DCEBFA",
      lastFillColor: "#AABBCC",
    })).toEqual({ fill: "#DCEBFA" });

    expect(resolveClosedShapeFill({
      fillEnabled: false,
      fill: null,
      lastFillColor: "#DCEBFA",
    })).toEqual({ fill: undefined });
  });

  it("keeps editor hit area when fill is disabled without using solid white", () => {
    expect(closedShapeFillStyle({
      fillEnabled: false,
      fill: null,
      lastFillColor: "#DCEBFA",
      forHitTesting: true,
    })).toEqual({ fill: undefined, fillEnabled: false });
    expect(closedShapeFillStyle({
      fillEnabled: false,
      fill: null,
      lastFillColor: "#DCEBFA",
      forHitTesting: false,
    })).toEqual({
      fill: undefined,
      fillEnabled: false,
    });
  });

  it("never treats white as the no-fill representation", () => {
    const hollow = resolveClosedShapeFill({
      fillEnabled: false,
      fill: null,
      lastFillColor: "#FFFFFF",
    });
    expect(hollow.fill).toBeUndefined();
    expect(hollow.fill).not.toBe("#FFFFFF");
  });
});

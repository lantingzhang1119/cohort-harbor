import { describe, expect, it } from "vitest";

import {
  clampCrop,
  effectiveCoverCrop,
  initialCropForSession,
  panCrop,
  resetCrop,
  zoomCrop,
} from "@/features/portal/editor/image-crop";

describe("portal image crop math", () => {
  it("couples crop edges so the persisted rectangle stays inside 0..1", () => {
    expect(clampCrop({
      x: 0.95,
      y: -0.2,
      width: 0.5,
      height: 0,
    })).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.01,
    });

    expect(clampCrop({
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: -2,
      height: 4,
    })).toEqual({
      x: 0,
      y: 0,
      width: 0.01,
      height: 1,
    });
  });

  it("canonicalizes the implicit COVER crop for the source and frame aspects", () => {
    expect(effectiveCoverCrop(
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 400, height: 200 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });

    const nested = effectiveCoverCrop(
      { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      { width: 400, height: 200 },
      { width: 64, height: 48 },
    );
    expect(nested.x).toBeCloseTo(0.25);
    expect(nested.y).toBeCloseTo(0.2);
    expect(nested.width).toBeCloseTo(0.4);
    expect(nested.height).toBeCloseTo(0.6);
  });

  it("pans in frame-local coordinates and clamps without changing crop size", () => {
    const moved = panCrop(
      { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
      { x: 20, y: -10 },
      {
        fitMode: "COVER",
        source: { width: 100, height: 50 },
        frame: { width: 100, height: 50 },
      },
    );
    expect(moved.x).toBeCloseTo(0.15);
    expect(moved.y).toBeCloseTo(0.3);
    expect(moved.width).toBe(0.5);
    expect(moved.height).toBe(0.5);

    expect(panCrop(
      { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
      { x: 1_000, y: -1_000 },
      {
        fitMode: "COVER",
        source: { width: 100, height: 50 },
        frame: { width: 100, height: 50 },
      },
    )).toEqual({
      x: 0,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("maps CONTAIN panning through the rendered image size inside letterbox space", () => {
    const moved = panCrop(
      { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      { x: 0, y: -5 },
      {
        fitMode: "CONTAIN",
        source: { width: 100, height: 50 },
        frame: { width: 100, height: 100 },
      },
    );
    expect(moved.x).toBeCloseTo(0.1);
    expect(moved.y).toBeCloseTo(0.18);
    expect(moved.width).toBeCloseTo(0.8);
    expect(moved.height).toBeCloseTo(0.8);
  });

  it("canonicalizes COVER before mapping pan through the full frame", () => {
    expect(panCrop(
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 10, y: 0 },
      {
        fitMode: "COVER",
        source: { width: 100, height: 50 },
        frame: { width: 100, height: 100 },
      },
    )).toEqual({
      x: 0.2,
      y: 0,
      width: 0.5,
      height: 1,
    });
  });

  it("zooms around a normalized frame anchor and preserves the crop aspect", () => {
    expect(zoomCrop(
      { x: 0.2, y: 0.1, width: 0.6, height: 0.3 },
      2,
      { x: 0.25, y: 0.75 },
    )).toEqual({
      x: 0.275,
      y: 0.2125,
      width: 0.3,
      height: 0.15,
    });

    const minimum = zoomCrop(
      { x: 0, y: 0, width: 1, height: 0.5 },
      1_000,
    );
    expect(minimum.width).toBe(0.02);
    expect(minimum.height).toBe(0.01);
    expect(minimum.width / minimum.height).toBe(2);
    expect(minimum.x + minimum.width).toBeLessThanOrEqual(1);
    expect(minimum.y + minimum.height).toBeLessThanOrEqual(1);
  });

  it("starts from the current crop but resets both fit modes from the full source", () => {
    expect(initialCropForSession(
      "CONTAIN",
      { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      { width: 400, height: 200 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.6,
    });
    const coverEntry = initialCropForSession(
      "COVER",
      { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      { width: 400, height: 200 },
      { width: 64, height: 48 },
    );
    expect(coverEntry.x).toBeCloseTo(0.25);
    expect(coverEntry.y).toBeCloseTo(0.2);
    expect(coverEntry.width).toBeCloseTo(0.4);
    expect(coverEntry.height).toBeCloseTo(0.6);

    expect(resetCrop(
      "COVER",
      { width: 400, height: 200 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });
    expect(resetCrop(
      "CONTAIN",
      { width: 400, height: 200 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

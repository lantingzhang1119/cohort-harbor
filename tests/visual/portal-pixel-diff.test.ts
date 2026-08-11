import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  assertHighInformationCrop,
  locateColorMaskBounds,
  measureImageContentStats,
  rgbaPixelDiffRatio,
} from "./portal-pixel-diff";

const OFFICE_MAP_SHA256 =
  "500cd332e592bd61d227d5ab1a9c5355f0da81d27afc44759d7cf11710fe95fc";

describe("rgbaPixelDiffRatio", () => {
  it("reports near-zero difference for identical solid crops after resize", async () => {
    const solid = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).png().toBuffer();
    const ratio = await rgbaPixelDiffRatio(solid, solid, { width: 20, height: 15 });
    expect(ratio).toBe(0);
  });

  it("detects a full mismatch between different solid colors", async () => {
    const white = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).png().toBuffer();
    const black = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    }).png().toBuffer();
    const ratio = await rgbaPixelDiffRatio(white, black, { width: 16, height: 16 });
    expect(ratio).toBe(1);
  });

  it("freezes the synthetic office-map fixture bytes and size", async () => {
    const fixturePath = path.join(process.cwd(), "tests/fixtures/office-map.png");
    const bytes = readFileSync(fixturePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(OFFICE_MAP_SHA256);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1_014);
    expect(meta.height).toBe(1_314);
    expect(meta.format).toBe("png");
  });

  it("rejects solid empty crops via high-information stats", async () => {
    const solid = await sharp({
      create: {
        width: 48,
        height: 48,
        channels: 3,
        background: { r: 245, g: 245, b: 245 },
      },
    }).png().toBuffer();
    const stats = await measureImageContentStats(solid);
    expect(() => assertHighInformationCrop(stats, "solid")).toThrow(/empty|letterbox/i);
  });

  it("accepts a high-information crop from the synthetic office-map fixture", async () => {
    const fixturePath = path.join(process.cwd(), "tests/fixtures/office-map.png");
    const crop = await sharp(readFileSync(fixturePath))
      .extract({ left: 200, top: 300, width: 96, height: 96 })
      .png()
      .toBuffer();
    const stats = await measureImageContentStats(crop);
    expect(() => assertHighInformationCrop(stats, "office-map")).not.toThrow();
  });

  it("locates a pure magenta rectangle by color mask", async () => {
    const png = await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 3,
        background: { r: 10, g: 10, b: 10 },
      },
    })
      .composite([{
        input: await sharp({
          create: {
            width: 30,
            height: 20,
            channels: 3,
            background: { r: 255, g: 0, b: 255 },
          },
        }).png().toBuffer(),
        left: 40,
        top: 25,
      }])
      .png()
      .toBuffer();
    const mask = await locateColorMaskBounds(png, { r: 255, g: 0, b: 255 }, 8);
    expect(mask).not.toBeNull();
    expect(mask!.minX).toBe(40);
    expect(mask!.minY).toBe(25);
    expect(mask!.maxX).toBe(69);
    expect(mask!.maxY).toBe(44);
  });

  it("locates stroke endpoints from leftmost/rightmost paint, not AABB midY", async () => {
    const { locateColorStrokeEndpoints } = await import("./portal-pixel-diff");
    // Diagonal red line-ish blob: left at y=10, right at y=40
    const png = await sharp({
      create: {
        width: 100,
        height: 60,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 4, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } },
          }).png().toBuffer(),
          left: 10,
          top: 10,
        },
        {
          input: await sharp({
            create: { width: 4, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } },
          }).png().toBuffer(),
          left: 70,
          top: 40,
        },
        {
          input: await sharp({
            create: { width: 60, height: 3, channels: 3, background: { r: 255, g: 0, b: 0 } },
          }).png().toBuffer(),
          left: 12,
          top: 25,
        },
      ])
      .png()
      .toBuffer();
    const ends = await locateColorStrokeEndpoints(png, { r: 255, g: 0, b: 0 }, 8);
    expect(ends).not.toBeNull();
    expect(ends!.end.x).toBeGreaterThan(ends!.start.x);
    // Endpoints must track the vertical extremes of the stroke, not a single mid-band.
    expect(ends!.start.y).toBeLessThan(ends!.end.y);
    expect(Math.abs(ends!.start.y - ends!.end.y)).toBeGreaterThan(5);
  });
});

import { describe, expect, it } from "vitest";

import {
  defaultPortalScene,
  normalizePortalScene,
  portalSceneV1Schema,
} from "@/features/portal/portal-scene";

describe("portal auto-height canvas contract", () => {
  it("upgrades a legacy fixed scene with explicit logical canvas dimensions", () => {
    const legacy = defaultPortalScene("DESKTOP") as unknown as Record<string, unknown>;
    delete legacy.canvas;
    const background = { ...(legacy.background as Record<string, unknown>) };
    delete background.naturalWidth;
    delete background.naturalHeight;

    const parsed = portalSceneV1Schema.parse({ ...legacy, background }) as unknown as {
      canvas: { logicalWidth: number; logicalHeight: number };
      background: { naturalWidth: number | null; naturalHeight: number | null };
    };

    expect(parsed.canvas).toEqual({ logicalWidth: 1_440, logicalHeight: 900 });
    expect(parsed.background).toMatchObject({ naturalWidth: null, naturalHeight: null });
  });

  it("derives the desktop logical height from the uploaded background dimensions", () => {
    const scene = normalizePortalScene("DESKTOP", {
      ...defaultPortalScene("DESKTOP"),
      background: {
        ...defaultPortalScene("DESKTOP").background,
        assetId: "shanghai-floor-map",
        fitMode: "AUTO_HEIGHT",
        naturalWidth: 1_625,
        naturalHeight: 6_375,
      },
    }) as unknown as {
      canvas: { logicalWidth: number; logicalHeight: number };
      background: { fitMode: string; naturalWidth: number; naturalHeight: number };
    };

    expect(scene.background).toMatchObject({
      fitMode: "AUTO_HEIGHT",
      naturalWidth: 1_625,
      naturalHeight: 6_375,
    });
    expect(scene.canvas.logicalWidth).toBe(1_440);
    expect(scene.canvas.logicalHeight).toBeCloseTo(1_440 * 6_375 / 1_625, 8);
  });

  it("keeps elements positioned below the old fixed-height viewport on a long canvas", () => {
    const scene = normalizePortalScene("DESKTOP", {
      ...defaultPortalScene("DESKTOP"),
      background: {
        ...defaultPortalScene("DESKTOP").background,
        assetId: "shanghai-floor-map",
        fitMode: "AUTO_HEIGHT",
        naturalWidth: 1_625,
        naturalHeight: 6_375,
      },
      elements: [{
        id: "roof-label",
        name: "楼顶",
        type: "TEXT",
        x: 600,
        y: 5_200,
        width: 240,
        height: 80,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        hidden: false,
        text: "楼顶",
        color: "#172033",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 30,
        fontWeight: 500,
        lineHeight: 1.4,
        align: "LEFT",
        italic: false,
        underline: false,
        letterSpacing: 0,
        backgroundColor: null,
        action: null,
      }],
    });

    expect(scene.elements[0]).toMatchObject({ y: 5_200, height: 80 });
  });
});

import { describe, expect, it } from "vitest";

import {
  parseStoredPortalScene,
  projectSceneToLegacyElements,
} from "@/features/portal/portal-scene-adapter";
import { defaultPortalScene } from "@/features/portal/portal-scene";

describe("portal scene legacy adapter", () => {
  it("maps v0 LOGO and IMAGE records to vendor-neutral V1 image elements", () => {
    const scene = parseStoredPortalScene({
      viewport: "DESKTOP",
      sceneVersion: 0,
      elements: [
        { id: "logo", kind: "LOGO", assetId: "asset-logo", assetUrl: "/api/files/asset-logo", x: 20, y: 30, width: 200, height: 80, zIndex: 9, altText: "CohortHarbor" },
        { id: "hero", kind: "IMAGE", assetId: "asset-hero", x: 0, y: 120, width: 1_400, height: 700, zIndex: 2, altText: "办公园区" },
      ],
    });

    expect(scene).toMatchObject({ sceneVersion: 1, viewport: "DESKTOP", requiresMobileReview: false });
    expect(scene.elements.map((element) => element.type)).toEqual(["IMAGE", "IMAGE"]);
    expect(scene.elements[0]).toMatchObject({ id: "logo", assetId: "asset-logo", zIndex: 1, fitMode: "CONTAIN" });
    expect(scene.elements[1]).toMatchObject({ id: "hero", assetId: "asset-hero", zIndex: 0, fitMode: "CONTAIN" });
    expect(JSON.stringify(scene)).not.toContain("assetUrl");
    expect(JSON.stringify(scene)).not.toContain("\"kind\"");
  });

  it("preserves legacy IDs and plain alt text accepted by the existing API", () => {
    const scene = parseStoredPortalScene({
      viewport: "MOBILE",
      elements: [{
        id: "前台 标志",
        kind: "LOGO",
        assetId: "legacy-logo",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        zIndex: 0,
        altText: "园区 <总部>",
      }],
    });

    expect(scene.elements[0]).toMatchObject({ id: "前台 标志", name: "园区 <总部>", altText: "园区 <总部>" });
  });

  it("preserves a maximum-length legacy alt while deriving a bounded editor name", () => {
    const altText = "园".repeat(300);
    const scene = parseStoredPortalScene({
      viewport: "DESKTOP",
      elements: [{
        id: "long-alt",
        kind: "IMAGE",
        assetId: "legacy-image",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        zIndex: 0,
        altText,
      }],
    });

    expect(scene.elements[0]).toMatchObject({ name: "园".repeat(100), altText });
  });

  it("parses stored V1 scenes and rejects unsupported versions", () => {
    const scene = defaultPortalScene("MOBILE");
    expect(parseStoredPortalScene({ viewport: "MOBILE", sceneVersion: 1, scene })).toEqual(scene);
    expect(() => parseStoredPortalScene({ viewport: "MOBILE", sceneVersion: 2, scene })).toThrow();
  });

  it("projects only V1 image elements to the existing legacy contract", () => {
    const scene = parseStoredPortalScene({
      viewport: "MOBILE",
      sceneVersion: 0,
      elements: [{ id: "hero", kind: "IMAGE", assetId: "asset-hero", x: 5, y: 7, width: 300, height: 200, zIndex: 3, altText: "园区" }],
    });
    scene.elements.push({
      id: "caption",
      name: "说明",
      type: "TEXT",
      x: 10,
      y: 220,
      width: 300,
      height: 50,
      rotation: 0,
      opacity: 1,
      zIndex: 1,
      locked: false,
      hidden: false,
      text: "欢迎",
      color: "#000000",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 24,
      fontWeight: 400,
      lineHeight: 1.4,
      align: "LEFT",
      italic: false,
      underline: false,
      letterSpacing: 0,
      backgroundColor: null,
      action: null,
    });

    expect(projectSceneToLegacyElements(scene)).toEqual([{
      id: "hero",
      kind: "IMAGE",
      assetId: "asset-hero",
      x: 5,
      y: 7,
      width: 300,
      height: 200,
      zIndex: 0,
      altText: "园区",
    }]);
  });
});

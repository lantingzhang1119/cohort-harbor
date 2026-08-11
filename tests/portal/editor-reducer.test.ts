import { describe, expect, it } from "vitest";

import {
  createElementAtViewportCenter,
  editorReducer,
  type EditorState,
} from "@/features/portal/editor/editor-reducer";
import {
  normalizePortalScene,
  type PortalElement,
  type PortalSceneV1,
} from "@/features/portal/portal-scene";

const element: PortalElement = {
  id: "welcome",
  name: "欢迎语",
  type: "TEXT",
  x: 10,
  y: 20,
  width: 160,
  height: 48,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  text: "欢迎加入",
  color: "#112233",
  fontFamily: "Noto Sans SC Variable",
  fontSize: 24,
  fontWeight: 400,
  lineHeight: 1.5,
  align: "LEFT",
  italic: false,
  underline: false,
  letterSpacing: 0,
  backgroundColor: null,
  action: null,
};

const imageElement: PortalElement = {
  id: "office",
  name: "办公环境",
  type: "IMAGE",
  x: 100,
  y: 100,
  width: 320,
  height: 220,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  assetId: "asset-office",
  altText: "办公环境",
  fitMode: "COVER",
  crop: { x: 0, y: 0, width: 1, height: 1 },
  cornerRadius: 0,
  action: null,
};

function scene(elements: PortalElement[] = [element]): PortalSceneV1 {
  return {
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
    elements,
  };
}

function initialState(present = scene()): EditorState {
  return {
    past: [],
    present,
    future: [],
    selection: [],
    dirty: false,
    editVersion: 0,
    revision: 0,
    city: "SHANGHAI",
    viewport: "DESKTOP",
    zoom: 1,
    snapEnabled: true,
    transientPreview: null,
    clipboard: null,
  };
}

describe("editorReducer", () => {
  it("acknowledges a saved server revision without overwriting edits made after save started", () => {
    const firstEdit = editorReducer(initialState(), {
      type: "COMMIT_ELEMENT",
      id: "welcome",
      patch: { x: 210 },
    });
    const savedEditVersion = firstEdit.editVersion;
    const laterEdit = editorReducer(firstEdit, {
      type: "COMMIT_ELEMENT",
      id: "welcome",
      patch: { x: 310 },
    });

    const acknowledged = editorReducer(laterEdit, {
      type: "MARK_SAVED",
      revision: 7,
      scene: {
        ...scene(),
        elements: [{ ...element, x: 210 }],
      },
      expectedEditVersion: savedEditVersion,
    });

    expect(acknowledged).toMatchObject({
      revision: 7,
      dirty: true,
      editVersion: laterEdit.editVersion,
    });
    expect(acknowledged.present.elements[0]?.x).toBe(310);
  });

  it("supports one-step undo and redo for direct manipulation", () => {
    const moved = editorReducer(initialState(), { type: "COMMIT_ELEMENT", id: "welcome", patch: { x: 210 } });

    expect(editorReducer(moved, { type: "UNDO" }).present.elements[0]?.x).toBe(10);
    expect(editorReducer(editorReducer(moved, { type: "UNDO" }), { type: "REDO" }).present.elements[0]?.x).toBe(210);
  });

  it("keeps pointer previews transient and caps committed snapshots at 100", () => {
    const preview = editorReducer(initialState(), { type: "PREVIEW_ELEMENT", id: "welcome", patch: { x: 32 } });
    expect(preview.past).toHaveLength(0);
    expect(preview.present.elements[0]?.x).toBe(10);
    expect(preview.transientPreview?.elements[0]?.x).toBe(32);

    let state = initialState();
    for (let x = 11; x <= 111; x += 1) {
      state = editorReducer(state, { type: "COMMIT_ELEMENT", id: "welcome", patch: { x } });
    }
    expect(state.past).toHaveLength(100);
    expect(state.present.elements[0]?.x).toBe(111);
    expect(editorReducer(state, { type: "UNDO" }).present.elements[0]?.x).toBe(110);
  });

  it("keeps repeated crop previews out of present/history and applies one undoable commit", () => {
    const baseline = initialState(scene([imageElement]));
    let preview = baseline;
    for (let index = 1; index <= 20; index += 1) {
      preview = editorReducer(preview, {
        type: "PREVIEW_ELEMENT",
        id: "office",
        patch: {
          crop: {
            x: index / 100,
            y: 0,
            width: 1 - index / 100,
            height: 1,
          },
        },
      });
    }
    expect(preview.present).toEqual(baseline.present);
    expect(preview.past).toEqual([]);
    expect(preview.dirty).toBe(false);

    const cancelled = editorReducer(preview, { type: "CLEAR_PREVIEW" });
    expect(cancelled).toMatchObject({
      present: baseline.present,
      past: [],
      dirty: false,
      transientPreview: null,
    });

    const applied = editorReducer(preview, {
      type: "COMMIT_ELEMENT",
      id: "office",
      patch: { crop: { x: 0.2, y: 0, width: 0.8, height: 1 } },
    });
    expect(applied.past).toHaveLength(1);
    expect(applied.dirty).toBe(true);
    expect(applied.present.elements[0]).toMatchObject({
      crop: { x: 0.2, y: 0, width: 0.8, height: 1 },
    });
    expect(editorReducer(applied, { type: "UNDO" }).present).toEqual(baseline.present);
  });

  it("rejects invalid committed patches and additions so history stays a strict scene", () => {
    const state = initialState();

    expect(editorReducer(state, { type: "COMMIT_ELEMENT", id: "welcome", patch: { x: 1_400 } })).toBe(state);
    expect(editorReducer(state, { type: "COMMIT_ELEMENT", id: "welcome", patch: { width: 0 } })).toBe(state);
    expect(editorReducer(state, { type: "ADD_ELEMENT", element: { ...element, id: "off-canvas", x: 1_400 } })).toBe(state);
  });

  it("does not mutate locked elements but permits hidden elements to be selected from layers", () => {
    const locked = { ...element, id: "locked", locked: true };
    const hidden = { ...element, id: "hidden", hidden: true, zIndex: 1 };
    const state = initialState(scene([locked, hidden]));

    const unchanged = editorReducer(state, { type: "COMMIT_ELEMENT", id: "locked", patch: { x: 99 } });
    expect(unchanged).toBe(state);
    expect(editorReducer(state, { type: "SELECT_ELEMENT", id: "hidden", source: "LAYERS" }).selection).toEqual(["hidden"]);
    expect(editorReducer(state, { type: "SELECT_ELEMENT", id: "hidden", source: "CANVAS" }).selection).toEqual([]);
  });

  it("duplicates and pastes structured elements with fresh IDs without an HTML clipboard", () => {
    const copied = editorReducer(initialState(), { type: "COPY_SELECTION", ids: ["welcome"] });
    expect(copied.clipboard).toEqual({ elements: [element] });
    expect(JSON.stringify(copied.clipboard)).not.toContain("<");

    const pasted = editorReducer(copied, { type: "PASTE" });
    expect(pasted.present.elements).toHaveLength(2);
    expect(pasted.present.elements[1]?.id).not.toBe("welcome");
    expect(pasted.present.elements[1]?.zIndex).toBe(1);
  });

  it("deep-clones copied elements so clipboard mutation cannot alias present or history", () => {
    const moved = editorReducer(initialState(), { type: "COMMIT_ELEMENT", id: "welcome", patch: { x: 210 } });
    const copied = editorReducer(moved, { type: "COPY_SELECTION", ids: ["welcome"] });
    copied.clipboard!.elements[0]!.x = 500;

    expect(copied.present.elements[0]?.x).toBe(210);
    expect(copied.past[0]?.elements[0]?.x).toBe(10);
  });

  it("duplicates and pastes edge-positioned maximum-name elements as valid fitted scenes", () => {
    const edge = { ...element, id: "edge", name: "x".repeat(100), x: 1_280, y: 852 };
    const duplicated = editorReducer(initialState(scene([edge])), { type: "DUPLICATE_ELEMENT", id: "edge" });
    const duplicate = duplicated.present.elements[1]!;
    expect(duplicated.present.elements).toHaveLength(2);
    expect(duplicate.id).not.toBe("edge");
    expect(duplicate.name).toHaveLength(100);
    expect(duplicate.x + duplicate.width).toBeLessThanOrEqual(1_440);
    expect(duplicate.y + duplicate.height).toBeLessThanOrEqual(900);

    const copied = editorReducer(initialState(scene([edge])), { type: "COPY_SELECTION", ids: ["edge"] });
    const pasted = editorReducer(copied, { type: "PASTE" });
    const paste = pasted.present.elements[1]!;
    expect(pasted.present.elements).toHaveLength(2);
    expect(paste.id).not.toBe("edge");
    expect(paste.x + paste.width).toBeLessThanOrEqual(1_440);
    expect(paste.y + paste.height).toBeLessThanOrEqual(900);
  });

  it("reconciles selection when undo removes newly created elements", () => {
    const added = editorReducer(initialState(), { type: "ADD_ELEMENT", element: { ...element, id: "second", zIndex: 1 } });

    expect(added.selection).toEqual(["second"]);
    expect(editorReducer(added, { type: "UNDO" }).selection).toEqual([]);
  });

  it("uses an explicit background lock action so a locked background can be unlocked", () => {
    const locked = editorReducer(initialState(), { type: "SET_BACKGROUND_LOCKED", locked: true });
    expect(editorReducer(locked, { type: "UPDATE_BACKGROUND", patch: { backgroundColor: "#000000" } })).toBe(locked);

    const unlocked = editorReducer(locked, { type: "SET_BACKGROUND_LOCKED", locked: false });
    expect(editorReducer(unlocked, { type: "UPDATE_BACKGROUND", patch: { backgroundColor: "#000000" } }).present.background.backgroundColor).toBe("#000000");
  });

  it("centers an element in the server-owned viewport dimensions", () => {
    expect(createElementAtViewportCenter(element, "DESKTOP")).toMatchObject({ x: 640, y: 426 });
    expect(createElementAtViewportCenter(element, "MOBILE")).toMatchObject({ x: 115, y: 398 });
  });

  it("duplicates and pastes against AUTO_HEIGHT canvas height instead of fixed 900", () => {
    const roof: PortalElement = {
      ...element,
      id: "roof",
      name: "楼顶",
      y: 5_200,
    };
    const longScene = normalizePortalScene("DESKTOP", {
      ...scene([roof]),
      background: {
        ...scene().background,
        assetId: "shanghai-floor-map",
        fitMode: "AUTO_HEIGHT",
        naturalWidth: 1_625,
        naturalHeight: 6_375,
      },
    });
    const expectedHeight = 1_440 * 6_375 / 1_625;
    expect(longScene.canvas?.logicalHeight).toBeCloseTo(expectedHeight, 5);

    const duplicated = editorReducer(initialState(longScene), {
      type: "DUPLICATE_ELEMENT",
      id: "roof",
    });
    const duplicate = duplicated.present.elements.find((candidate) => candidate.id !== "roof");
    expect(duplicate).toBeDefined();
    expect(duplicate!.y).toBeCloseTo(5_216, 5);
    expect(duplicate!.y).toBeGreaterThan(5_000);

    const copied = editorReducer(initialState(longScene), {
      type: "COPY_SELECTION",
      ids: ["roof"],
    });
    const pasted = editorReducer(copied, { type: "PASTE" });
    const paste = pasted.present.elements.find((candidate) => candidate.id !== "roof");
    expect(paste).toBeDefined();
    expect(paste!.y).toBeCloseTo(5_216, 5);
  });
});

import {
  normalizePortalScene,
  PORTAL_MAX_ELEMENTS,
  portalSceneV1Schema,
  type PortalElement,
  type PortalSceneV1,
  type PortalViewportInput,
} from "@/features/portal/portal-scene";
import { elementBounds, portalCanvasSize, portalSceneCanvasSize } from "@/features/portal/portal-geometry";

import type { EditorAction, EditorState, ElementPatch } from "./editor-types";

export type { EditorAction, EditorState } from "./editor-types";

const HISTORY_LIMIT = 100;
let generatedIdSequence = 0;

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withContinuousZIndexes(elements: PortalElement[]) {
  return elements.map((element, zIndex) => ({ ...element, zIndex })) as PortalElement[];
}

function cloneElement(element: PortalElement) {
  return JSON.parse(JSON.stringify(element)) as PortalElement;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Offset a duplicate/paste within the *scene* canvas (supports AUTO_HEIGHT long maps). */
function offsetElementWithinViewport(element: PortalElement, scene: PortalSceneV1) {
  const { canvasWidth, canvasHeight } = portalSceneCanvasSize(scene);
  const bounds = elementBounds(element);
  const boundsOffsetX = bounds.x - element.x;
  const boundsOffsetY = bounds.y - element.y;
  const minimumX = -boundsOffsetX;
  const maximumX = canvasWidth - bounds.width - boundsOffsetX;
  const minimumY = -boundsOffsetY;
  const maximumY = canvasHeight - bounds.height - boundsOffsetY;
  return {
    ...cloneElement(element),
    x: clamp(element.x + 16, minimumX, maximumX),
    y: clamp(element.y + 16, minimumY, maximumY),
  };
}

function duplicateName(name: string) {
  const suffix = " 副本";
  return `${name.slice(0, 100 - suffix.length)}${suffix}`;
}

function isStrictScene(scene: PortalSceneV1) {
  return portalSceneV1Schema.safeParse(scene).success;
}

function selectionInScene(selection: string[], scene: PortalSceneV1) {
  const ids = new Set(scene.elements.map((element) => element.id));
  return selection.filter((id) => ids.has(id));
}

function sceneWithPatchedElement(scene: PortalSceneV1, id: string, patch: ElementPatch) {
  const element = scene.elements.find((candidate) => candidate.id === id);
  if (!element || element.locked) return null;

  const { id: _ignoredId, type: _ignoredType, zIndex: _ignoredZIndex, ...safePatch } = patch;
  void _ignoredId;
  void _ignoredType;
  void _ignoredZIndex;
  const nextElement = { ...element, ...safePatch } as PortalElement;
  if (sameValue(element, nextElement)) return null;

  return {
    ...scene,
    elements: scene.elements.map((candidate) => candidate.id === id ? nextElement : candidate),
  };
}

function commit(state: EditorState, present: PortalSceneV1, selection = state.selection): EditorState {
  if (sameValue(state.present, present) || !isStrictScene(present)) return state;
  return {
    ...state,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present,
    future: [],
    selection: selectionInScene(selection, present),
    dirty: true,
    editVersion: state.editVersion + 1,
    transientPreview: null,
  };
}

function nextGeneratedId(existingIds: Set<string>) {
  let id: string;
  do {
    generatedIdSequence += 1;
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${generatedIdSequence.toString(36)}`;
    id = `element-${random}`.slice(0, 100);
  } while (existingIds.has(id));
  return id;
}

function selectedIds(action: { id?: string; ids?: string[] }, state: EditorState) {
  return new Set(action.ids ?? (action.id ? [action.id] : state.selection));
}

function canSelect(scene: PortalSceneV1, id: string, source: "CANVAS" | "LAYERS") {
  const element = scene.elements.find((candidate) => candidate.id === id);
  return Boolean(element && (!element.hidden || source === "LAYERS"));
}

function reorder(scene: PortalSceneV1, id: string, action: Extract<EditorAction, { type: "REORDER_ELEMENT" }>) {
  const ordered = [...scene.elements].sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  const fromIndex = ordered.findIndex((element) => element.id === id);
  if (fromIndex < 0 || ordered[fromIndex]?.locked) return null;
  const requested = action.toIndex ?? fromIndex + (action.direction === "FORWARD" ? 1 : -1);
  const toIndex = Math.max(0, Math.min(ordered.length - 1, requested));
  if (fromIndex === toIndex) return null;
  const [element] = ordered.splice(fromIndex, 1);
  ordered.splice(toIndex, 0, element!);
  return { ...scene, elements: withContinuousZIndexes(ordered) };
}

function shortcutAction(action: Extract<EditorAction, { type: "SHORTCUT" }>): EditorAction | null {
  const modifier = action.metaKey || action.ctrlKey;
  const key = action.key.toLowerCase();
  if (modifier && key === "z") return { type: action.shiftKey ? "REDO" : "UNDO" };
  if (modifier && key === "y") return { type: "REDO" };
  if (modifier && key === "c") return { type: "COPY_SELECTION" };
  if (modifier && key === "v") return { type: "PASTE" };
  if (modifier && key === "d") return { type: "DUPLICATE_ELEMENT" };
  if (key === "backspace" || key === "delete") return { type: "DELETE_ELEMENT" };
  return null;
}

export function createElementAtViewportCenter(element: PortalElement, viewport: PortalViewportInput): PortalElement {
  const { canvasWidth, canvasHeight } = portalCanvasSize(viewport);
  return {
    ...element,
    x: Math.max(0, (canvasWidth - element.width) / 2),
    y: Math.max(0, (canvasHeight - element.height) / 2),
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "SHORTCUT") {
    const translated = shortcutAction(action);
    return translated ? editorReducer(state, translated) : state;
  }

  switch (action.type) {
    case "LOAD_CONTEXT": {
      if (
        action.scene.viewport !== action.viewport
        || !isStrictScene(action.scene)
        || !Number.isInteger(action.revision)
        || action.revision < 0
      ) return state;
      return {
        ...state,
        past: [],
        present: action.scene,
        future: [],
        selection: [],
        dirty: false,
        editVersion: 0,
        revision: action.revision,
        city: action.city,
        viewport: action.viewport,
        zoom: action.viewport === "MOBILE" ? 0.72 : 0.5,
        transientPreview: null,
      };
    }
    case "MARK_SAVED": {
      if (
        action.scene.viewport !== state.viewport
        || !isStrictScene(action.scene)
        || !Number.isInteger(action.revision)
        || action.revision < 0
      ) return state;
      if (action.expectedEditVersion !== state.editVersion) {
        return {
          ...state,
          revision: action.revision,
        };
      }
      return {
        ...state,
        past: [],
        present: action.scene,
        future: [],
        selection: selectionInScene(state.selection, action.scene),
        dirty: false,
        revision: action.revision,
        transientPreview: null,
      };
    }
    case "RESTORE_LOCAL": {
      if (action.scene.viewport !== state.viewport || !isStrictScene(action.scene)) {
        return state;
      }
      return {
        ...state,
        past: sameValue(state.present, action.scene)
          ? state.past
          : [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: action.scene,
        future: [],
        selection: selectionInScene(state.selection, action.scene),
        dirty: true,
        editVersion: state.editVersion + 1,
        transientPreview: null,
      };
    }
    case "UNDO": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        selection: selectionInScene(state.selection, previous),
        dirty: true,
        editVersion: state.editVersion + 1,
        transientPreview: null,
      };
    }
    case "REDO": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: state.future.slice(1),
        selection: selectionInScene(state.selection, next),
        dirty: true,
        editVersion: state.editVersion + 1,
        transientPreview: null,
      };
    }
    case "PREVIEW_ELEMENT": {
      const base = state.transientPreview ?? state.present;
      const preview = sceneWithPatchedElement(base, action.id, action.patch);
      return preview ? { ...state, transientPreview: preview } : state;
    }
    case "CLEAR_PREVIEW":
      return state.transientPreview ? { ...state, transientPreview: null } : state;
    case "COMMIT_ELEMENT": {
      const next = sceneWithPatchedElement(state.present, action.id, action.patch);
      return next ? commit(state, next) : state;
    }
    case "ADD_ELEMENT": {
      if (state.present.elements.length >= PORTAL_MAX_ELEMENTS) return state;
      const existingIds = new Set(state.present.elements.map((element) => element.id));
      const element = cloneElement(action.element);
      if (existingIds.has(element.id)) element.id = nextGeneratedId(existingIds);
      const elements = withContinuousZIndexes([...state.present.elements, { ...element, zIndex: state.present.elements.length }]);
      return commit(state, { ...state.present, elements }, [element.id]);
    }
    case "DELETE_ELEMENT": {
      const ids = selectedIds(action, state);
      const removable = state.present.elements.filter((element) => ids.has(element.id) && !element.locked);
      if (removable.length === 0) return state;
      const elements = withContinuousZIndexes(state.present.elements.filter((element) => !removable.includes(element)));
      return commit(state, { ...state.present, elements }, state.selection.filter((id) => !ids.has(id)));
    }
    case "DUPLICATE_ELEMENT": {
      const ids = selectedIds(action, state);
      const sources = state.present.elements.filter((element) => ids.has(element.id) && !element.locked);
      if (sources.length === 0 || state.present.elements.length + sources.length > PORTAL_MAX_ELEMENTS) return state;
      const existingIds = new Set(state.present.elements.map((element) => element.id));
      const duplicates = sources.map((element) => {
        const id = nextGeneratedId(existingIds);
        existingIds.add(id);
        return { ...offsetElementWithinViewport(element, state.present), id, name: duplicateName(element.name) };
      });
      const elements = withContinuousZIndexes([...state.present.elements, ...duplicates]);
      return commit(state, { ...state.present, elements }, duplicates.map((element) => element.id));
    }
    case "COPY_SELECTION": {
      const ids = selectedIds(action, state);
      const elements = state.present.elements.filter((element) => ids.has(element.id)).map(cloneElement);
      return elements.length === 0 ? state : { ...state, clipboard: { elements } };
    }
    case "PASTE": {
      const copied = state.clipboard?.elements ?? [];
      if (copied.length === 0 || state.present.elements.length + copied.length > PORTAL_MAX_ELEMENTS) return state;
      const existingIds = new Set(state.present.elements.map((element) => element.id));
      const pasted = copied.map((element) => {
        const id = nextGeneratedId(existingIds);
        existingIds.add(id);
        return { ...offsetElementWithinViewport(element, state.present), id };
      });
      const elements = withContinuousZIndexes([...state.present.elements, ...pasted]);
      return commit(state, { ...state.present, elements }, pasted.map((element) => element.id));
    }
    case "REORDER_ELEMENT": {
      const next = reorder(state.present, action.id, action);
      return next ? commit(state, next) : state;
    }
    case "RENAME_ELEMENT": {
      const element = state.present.elements.find((candidate) => candidate.id === action.id);
      if (!element || element.locked || element.name === action.name) return state;
      return commit(state, { ...state.present, elements: state.present.elements.map((candidate) => candidate.id === action.id ? { ...candidate, name: action.name } : candidate) });
    }
    case "SET_ELEMENT_HIDDEN":
    case "TOGGLE_ELEMENT_HIDDEN": {
      const element = state.present.elements.find((candidate) => candidate.id === action.id);
      if (!element || element.locked) return state;
      const hidden = action.type === "SET_ELEMENT_HIDDEN" ? action.hidden : !element.hidden;
      return commit(state, { ...state.present, elements: state.present.elements.map((candidate) => candidate.id === action.id ? { ...candidate, hidden } : candidate) });
    }
    case "SET_ELEMENT_LOCKED":
    case "TOGGLE_ELEMENT_LOCKED": {
      const element = state.present.elements.find((candidate) => candidate.id === action.id);
      if (!element) return state;
      const locked = action.type === "SET_ELEMENT_LOCKED" ? action.locked : !element.locked;
      return commit(state, { ...state.present, elements: state.present.elements.map((candidate) => candidate.id === action.id ? { ...candidate, locked } : candidate) });
    }
    case "UPDATE_BACKGROUND": {
      if (state.present.background.locked) return state;
      const { locked: _ignoredLocked, ...patch } = action.patch;
      void _ignoredLocked;
      const background = { ...state.present.background, ...patch };
      try {
        return commit(state, normalizePortalScene(state.viewport, { ...state.present, background }));
      } catch {
        return state;
      }
    }
    case "SET_BACKGROUND_LOCKED":
    case "TOGGLE_BACKGROUND_LOCKED": {
      const locked = action.type === "SET_BACKGROUND_LOCKED" ? action.locked : !state.present.background.locked;
      if (locked === state.present.background.locked) return state;
      return commit(state, { ...state.present, background: { ...state.present.background, locked } });
    }
    case "SELECT_ELEMENT": {
      if (!action.id) return state.selection.length === 0 ? state : { ...state, selection: [] };
      const source = action.source ?? "CANVAS";
      if (!canSelect(state.present, action.id, source)) return action.append ? state : { ...state, selection: [] };
      const selection = action.append
        ? state.selection.includes(action.id) ? state.selection.filter((id) => id !== action.id) : [...state.selection, action.id]
        : [action.id];
      return sameValue(selection, state.selection) ? state : { ...state, selection };
    }
    case "SELECT_ELEMENTS": {
      const source = action.source ?? "CANVAS";
      const selection = action.ids.filter((id) => canSelect(state.present, id, source));
      return sameValue(selection, state.selection) ? state : { ...state, selection };
    }
    case "SET_ZOOM": {
      const zoom = Math.min(4, Math.max(0.1, action.zoom));
      return zoom === state.zoom ? state : { ...state, zoom };
    }
    case "SET_SNAP_ENABLED":
      return action.enabled === state.snapEnabled ? state : { ...state, snapEnabled: action.enabled };
  }
}

import type { PortalElement, PortalSceneV1, PortalViewportInput } from "@/features/portal/portal-scene";

export type EditorCity = string;
export type EditorSelectionSource = "CANVAS" | "LAYERS";
export type EditorClipboard = { elements: PortalElement[] };

export type EditorState = {
  past: PortalSceneV1[];
  present: PortalSceneV1;
  future: PortalSceneV1[];
  selection: string[];
  dirty: boolean;
  editVersion: number;
  revision: number;
  city: EditorCity;
  viewport: PortalViewportInput;
  zoom: number;
  snapEnabled: boolean;
  transientPreview: PortalSceneV1 | null;
  clipboard: EditorClipboard | null;
};

export type ElementPatch = Partial<PortalElement>;

export type EditorAction =
  | {
      type: "LOAD_CONTEXT";
      city: EditorCity;
      viewport: PortalViewportInput;
      revision: number;
      scene: PortalSceneV1;
    }
  | {
      type: "MARK_SAVED";
      revision: number;
      scene: PortalSceneV1;
      expectedEditVersion: number;
    }
  | { type: "RESTORE_LOCAL"; scene: PortalSceneV1 }
  | { type: "ADD_ELEMENT"; element: PortalElement }
  | { type: "COMMIT_ELEMENT"; id: string; patch: ElementPatch }
  | { type: "PREVIEW_ELEMENT"; id: string; patch: ElementPatch }
  | { type: "CLEAR_PREVIEW" }
  | { type: "DELETE_ELEMENT"; id?: string; ids?: string[] }
  | { type: "DUPLICATE_ELEMENT"; id?: string; ids?: string[] }
  | { type: "COPY_SELECTION"; ids?: string[] }
  | { type: "PASTE" }
  | { type: "REORDER_ELEMENT"; id: string; toIndex?: number; direction?: "FORWARD" | "BACKWARD" }
  | { type: "RENAME_ELEMENT"; id: string; name: string }
  | { type: "SET_ELEMENT_HIDDEN"; id: string; hidden: boolean }
  | { type: "TOGGLE_ELEMENT_HIDDEN"; id: string }
  | { type: "SET_ELEMENT_LOCKED"; id: string; locked: boolean }
  | { type: "TOGGLE_ELEMENT_LOCKED"; id: string }
  | { type: "UPDATE_BACKGROUND"; patch: Partial<PortalSceneV1["background"]> }
  | { type: "SET_BACKGROUND_LOCKED"; locked: boolean }
  | { type: "TOGGLE_BACKGROUND_LOCKED" }
  | { type: "SELECT_ELEMENT"; id: string | null; source?: EditorSelectionSource; append?: boolean }
  | { type: "SELECT_ELEMENTS"; ids: string[]; source?: EditorSelectionSource }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "SET_SNAP_ENABLED"; enabled: boolean }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "SHORTCUT"; key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };

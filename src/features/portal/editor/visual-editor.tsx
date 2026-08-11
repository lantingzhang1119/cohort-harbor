"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { PublishedScene } from "@/features/portal/components/published-scene";
import { portalSceneCanvasSize } from "@/features/portal/portal-geometry";
import { AssetPanel, type PortalAsset } from "@/features/portal/editor/asset-panel";
import {
  ComponentPanel,
  createDefaultPortalElement,
} from "@/features/portal/editor/component-panel";
import {
  clearPortalRecoveryForUser,
  loadRecovery,
  portalRecoveryStorage,
  recoveryKey,
  saveRecovery,
} from "@/features/portal/editor/editor-recovery";
import { editorReducer } from "@/features/portal/editor/editor-reducer";
import { EditorStage } from "@/features/portal/editor/editor-stage";
import { EditorToolbar } from "@/features/portal/editor/editor-toolbar";
import type { EditorState } from "@/features/portal/editor/editor-types";
import { LayerPanel } from "@/features/portal/editor/layer-panel";
import { PagePanel } from "@/features/portal/editor/page-panel";
import { PropertyPanel } from "@/features/portal/editor/property-panel";
import {
  defaultPortalScene,
  normalizePortalScene,
  PORTAL_MAX_ELEMENTS,
  portalSceneV1Schema,
  type PortalElement,
  type PortalElementType,
  type PortalSceneV1,
  type PortalViewportInput,
} from "@/features/portal/portal-scene";

import styles from "./visual-editor.module.css";

type PortalHistoryEntry = {
  version: number;
  createdAt: string;
  publishedBySnapshot: unknown;
};

const CITIES = [
  ["SHANGHAI", "上海"],
  ["SHENZHEN", "深圳"],
  ["CHANGSHA", "长沙"],
  ["XIAN", "西安"],
] as const;

const CITY_LABELS = Object.fromEntries(CITIES) as Record<string, string>;
const TOOL_LABELS = ["添加组件", "页面设置", "素材库", "图层"] as const;
type EditorTool = typeof TOOL_LABELS[number];

type EditorContext = {
  city: string;
  viewport: PortalViewportInput;
};

type CapturedContext = EditorContext & {
  revision: number;
  scene: PortalSceneV1;
  generation: number;
  editVersion: number;
};

type DraftPayload = {
  revision: number;
  scene: PortalSceneV1;
};

type ConflictState = CapturedContext & {
  message: string;
};

type PendingPublication = {
  city: string;
  generation: number;
  mobileReviewRequired: boolean;
  revisions: { desktop: number; mobile: number };
};

type CropTargetSnapshot = {
  id: string;
  assetId: string;
  fitMode: "CONTAIN" | "COVER";
  city: string;
  viewport: PortalViewportInput;
};

type AssetMutation =
  | {
    sequence: number;
    type: "UPSERT";
    asset: PortalAsset;
  }
  | {
    sequence: number;
    type: "DELETE";
    assetId: string;
  };

type BusyState = "loading" | "saving" | "publishing" | null;

class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "WORKFLOW_ERROR",
  ) {
    super(message);
  }
}

export type VisualEditorProps = {
  userId: string;
  initialCity?: string;
  initialViewport?: PortalViewportInput;
  initialScene?: PortalSceneV1;
  initialRevision?: number;
};

function initialEditorState({
  initialCity = "SHANGHAI",
  initialViewport,
  initialScene,
  initialRevision = 0,
}: VisualEditorProps): EditorState {
  const viewport = initialViewport ?? initialScene?.viewport ?? "DESKTOP";
  const scene = initialScene?.viewport === viewport
    ? initialScene
    : defaultPortalScene(viewport);

  return {
    past: [],
    present: scene,
    future: [],
    selection: [],
    dirty: false,
    editVersion: 0,
    revision: initialRevision,
    city: initialCity,
    viewport,
    zoom: viewport === "MOBILE" ? 0.72 : 0.5,
    snapEnabled: true,
    transientPreview: null,
    clipboard: null,
  };
}

function draftUrl({ city, viewport }: EditorContext) {
  return `/api/admin/portal/${encodeURIComponent(city)}/draft?viewport=${encodeURIComponent(viewport)}`;
}

function mutationUrl(city: string, resource: "draft" | "publish") {
  return `/api/admin/portal/${encodeURIComponent(city)}/${resource}`;
}

async function responseJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new WorkflowError("服务器返回了无法识别的响应", response.status);
  }
}

function responseError(response: Response, value: unknown) {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return new WorkflowError(
    typeof record.message === "string" ? record.message : "请求失败，请稍后重试",
    response.status,
    typeof record.code === "string" ? record.code : "REQUEST_FAILED",
  );
}

function assetUrl(city: string, assetId?: string) {
  const base = `/api/admin/portal/${encodeURIComponent(city)}/assets`;
  return assetId ? `${base}?assetId=${encodeURIComponent(assetId)}` : base;
}

function strictAssets(value: unknown): PortalAsset[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { assets?: unknown }).assets)) {
    throw new WorkflowError("素材库响应格式无效");
  }
  return (value as { assets: unknown[] }).assets.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const asset = candidate as Partial<PortalAsset>;
    if (
      typeof asset.id !== "string"
      || typeof asset.originalName !== "string"
      || typeof asset.mimeType !== "string"
      || typeof asset.url !== "string"
    ) return [];
    const references = asset.references ?? { draft: [], current: [], history: [] };
    return [{
      id: asset.id,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: typeof asset.sizeBytes === "number" ? asset.sizeBytes : 0,
      createdAt: typeof asset.createdAt === "string" ? asset.createdAt : "",
      category: typeof asset.category === "string" ? asset.category : "UNCLASSIFIED",
      width: typeof asset.width === "number" ? asset.width : null,
      height: typeof asset.height === "number" ? asset.height : null,
      inspectionStatus: typeof asset.inspectionStatus === "string" ? asset.inspectionStatus : "VALID",
      searchText: typeof asset.searchText === "string"
        ? asset.searchText
        : `${asset.originalName} ${asset.mimeType}`.toLocaleLowerCase("zh-CN"),
      references: {
        draft: Array.isArray(references.draft) ? references.draft : [],
        current: Array.isArray(references.current) ? references.current : [],
        history: Array.isArray(references.history) ? references.history : [],
      },
      referenceCounts: asset.referenceCounts ?? {
        draft: Array.isArray(references.draft) ? references.draft.length : 0,
        current: Array.isArray(references.current) ? references.current.length : 0,
        history: Array.isArray(references.history) ? references.history.length : 0,
      },
      unused: asset.unused === true,
      url: asset.url,
    }];
  });
}

function uploadedAsset(value: unknown): PortalAsset {
  if (typeof value !== "object" || value === null || typeof (value as { asset?: unknown }).asset !== "object") {
    throw new WorkflowError("素材上传响应格式无效");
  }
  return strictAssets({
    assets: [{
      ...(value as { asset: object }).asset,
      references: { draft: [], current: [], history: [] },
      referenceCounts: { draft: 0, current: 0, history: 0 },
      unused: true,
      searchText: "",
    }],
  })[0] ?? (() => { throw new WorkflowError("素材上传响应缺少有效素材"); })();
}

function replayAssetMutations(
  snapshot: PortalAsset[],
  mutations: AssetMutation[],
) {
  return mutations.reduce<PortalAsset[]>((current, mutation) => {
    if (mutation.type === "DELETE") {
      return current.filter(({ id }) => id !== mutation.assetId);
    }
    return [
      mutation.asset,
      ...current.filter(({ id }) => id !== mutation.asset.id),
    ];
  }, snapshot);
}

function isInteractiveEditorTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("button, a, input, textarea, select, [contenteditable='true'], .ProseMirror")
    || target.isContentEditable,
  );
}

function strictDraft(value: unknown, viewport: PortalViewportInput): DraftPayload {
  if (typeof value !== "object" || value === null) {
    throw new WorkflowError("草稿响应格式无效");
  }
  const draft = (value as { draft?: unknown }).draft;
  if (draft === null) return { revision: 0, scene: defaultPortalScene(viewport) };
  if (typeof draft !== "object" || draft === null) {
    throw new WorkflowError("草稿响应缺少 draft");
  }
  const record = draft as Record<string, unknown>;
  if (!Number.isInteger(record.revision) || Number(record.revision) < 0) {
    throw new WorkflowError("草稿 revision 无效");
  }
  const parsed = portalSceneV1Schema.safeParse(record.scene);
  if (!parsed.success || parsed.data.viewport !== viewport) {
    throw new WorkflowError("草稿场景不符合严格 V1 契约");
  }
  return {
    revision: Number(record.revision),
    scene: parsed.data as PortalSceneV1,
  };
}

async function fetchDraft(context: EditorContext) {
  const response = await fetch(draftUrl(context));
  const value = await responseJson(response);
  if (!response.ok) throw responseError(response, value);
  return strictDraft(value, context.viewport);
}

export function VisualEditor(props: VisualEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, props, initialEditorState);
  const [busy, setBusy] = useState<BusyState>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [recoveryCandidate, setRecoveryCandidate] = useState<PortalSceneV1 | null>(null);
  const [pendingPublication, setPendingPublication] = useState<PendingPublication | null>(null);
  const [activeTool, setActiveTool] = useState<EditorTool>("添加组件");
  const [drawTool, setDrawTool] = useState<"FREEHAND" | null>(null);
  const [assets, setAssets] = useState<PortalAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsLoadedCity, setAssetsLoadedCity] = useState("");
  const [uploading, setUploading] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [cropTargetId, setCropTargetId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<PortalHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** History panel is valid only for this city + load generation. */
  const [historyScope, setHistoryScope] = useState<{ city: string; generation: number } | null>(null);
  /** Monotonic id for every history open (same-city reopen must invalidate prior in-flight). */
  const historyRequestIdRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const cropTargetIdRef = useRef<string | null>(null);
  const cropTargetSnapshotRef = useRef<CropTargetSnapshot | null>(null);
  const cropTriggerRef = useRef<HTMLButtonElement | null>(null);
  const contextRef = useRef<EditorContext>({
    city: state.city,
    viewport: state.viewport,
  });
  const generationRef = useRef(0);
  const assetLoadRequestRef = useRef(0);
  const assetMutationSequenceRef = useRef(0);
  const assetMutationLogRef = useRef<AssetMutation[]>([]);
  const busyTokenRef = useRef(0);
  const initialLoadRef = useRef(false);
  const stageScrollerRef = useRef<HTMLDivElement | null>(null);
  const stageFrameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const finishCrop = useCallback(() => {
    const trigger = cropTriggerRef.current;
    cropTargetIdRef.current = null;
    cropTargetSnapshotRef.current = null;
    cropTriggerRef.current = null;
    setCropTargetId(null);
    if (trigger?.isConnected && !trigger.disabled) {
      trigger.focus({ preventScroll: true });
    }
  }, []);

  const cancelCrop = useCallback(() => {
    if (!cropTargetIdRef.current) return;
    dispatch({ type: "CLEAR_PREVIEW" });
    finishCrop();
  }, [finishCrop]);

  const startCrop = useCallback(() => {
    if (!ready || busy === "saving" || busy === "publishing") return;
    const current = stateRef.current;
    const element = current.present.elements.find(
      (candidate): candidate is Extract<PortalElement, { type: "IMAGE" }> =>
        candidate.id === current.selection[0] && candidate.type === "IMAGE",
    );
    if (!element || element.locked || element.hidden) return;
    dispatch({ type: "CLEAR_PREVIEW" });
    const snapshot = {
      id: element.id,
      assetId: element.assetId,
      fitMode: element.fitMode,
      city: current.city,
      viewport: current.viewport,
    };
    cropTargetIdRef.current = element.id;
    cropTargetSnapshotRef.current = snapshot;
    cropTriggerRef.current = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : null;
    setCropTargetId(element.id);
  }, [busy, ready]);

  useEffect(() => {
    const snapshot = cropTargetSnapshotRef.current;
    if (!cropTargetId || !snapshot) return;
    const element = state.present.elements.find(({ id }) => id === cropTargetId);
    if (
      state.selection[0] !== cropTargetId
      || element?.type !== "IMAGE"
      || element.locked
      || element.hidden
      || element.assetId !== snapshot.assetId
      || element.fitMode !== snapshot.fitMode
      || state.city !== snapshot.city
      || state.viewport !== snapshot.viewport
    ) {
      cancelCrop();
    }
  }, [
    cancelCrop,
    cropTargetId,
    state.city,
    state.present.elements,
    state.selection,
    state.viewport,
  ]);

  const beginBusy = useCallback((next: Exclude<BusyState, null>) => {
    const token = ++busyTokenRef.current;
    setBusy(next);
    return token;
  }, []);

  const endBusy = useCallback((token: number) => {
    if (busyTokenRef.current === token) setBusy(null);
  }, []);

  const isCurrent = useCallback((captured: Pick<CapturedContext, "city" | "viewport" | "generation">) => {
    const current = contextRef.current;
    return generationRef.current === captured.generation
      && current.city === captured.city
      && current.viewport === captured.viewport;
  }, []);

  const invalidateHistoryRequest = useCallback(() => {
    historyRequestIdRef.current += 1;
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
  }, []);

  /** Single close path for toolbar, modal header, restore completion, and stale guards. */
  const closeHistoryPanel = useCallback(() => {
    invalidateHistoryRequest();
    setHistoryOpen(false);
    setHistoryEntries([]);
    setHistoryScope(null);
    setHistoryLoading(false);
  }, [invalidateHistoryRequest]);

  const loadContext = useCallback(async (
    context: EditorContext,
    options: {
      ignoreRecovery?: boolean;
      pendingPublication?: PendingPublication;
    } = {},
  ) => {
    if (cropTargetIdRef.current) {
      dispatch({ type: "CLEAR_PREVIEW" });
      cropTargetIdRef.current = null;
      cropTargetSnapshotRef.current = null;
      setCropTargetId(null);
    }
    const generation = ++generationRef.current;
    const captured = { ...context, generation };
    contextRef.current = context;
    setReady(false);
    setError("");
    setStatus(`正在加载${CITY_LABELS[context.city] ?? context.city}${context.viewport === "DESKTOP" ? "桌面" : "手机"}草稿…`);
    setConflict(null);
    setPendingPublication(options.pendingPublication
      ? { ...options.pendingPublication, generation }
      : null);
    setRecoveryCandidate(null);
    // History is city+generation scoped; never keep previous city entries open.
    closeHistoryPanel();
    setActiveTool("添加组件");
    setAssets([]);
    setAssetsLoading(false);
    setAssetsLoadedCity("");
    setUploading(false);
    setSelectedAssetId(null);
    dispatch({
      type: "LOAD_CONTEXT",
      city: context.city,
      viewport: context.viewport,
      revision: 0,
      scene: defaultPortalScene(context.viewport),
    });
    const busyToken = beginBusy("loading");

    try {
      const draft = await fetchDraft(context);
      if (!isCurrent(captured)) return;
      dispatch({
        type: "LOAD_CONTEXT",
        city: context.city,
        viewport: context.viewport,
        revision: draft.revision,
        scene: draft.scene,
      });
      setReady(true);
      setStatus(`${context.viewport === "DESKTOP" ? "桌面" : "手机"}草稿已加载`);
      const storage = portalRecoveryStorage();
      if (storage && !options.ignoreRecovery) {
        setRecoveryCandidate(loadRecovery(
          storage,
          props.userId,
          context.city,
          context.viewport,
        ));
      }
    } catch (caught) {
      if (!isCurrent(captured)) return;
      setReady(false);
      setError(caught instanceof Error ? caught.message : "草稿加载失败");
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, closeHistoryPanel, endBusy, isCurrent, props.userId]);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void loadContext({
      city: stateRef.current.city,
      viewport: stateRef.current.viewport,
    });
  }, [loadContext]);

  useEffect(() => {
    if (!ready || !state.dirty) return;
    const storage = portalRecoveryStorage();
    if (!storage) return;
    saveRecovery(
      storage,
      props.userId,
      state.city,
      state.viewport,
      state.present,
    );
  }, [props.userId, ready, state.city, state.dirty, state.present, state.viewport]);

  useEffect(() => {
    const protectUnload = (event: BeforeUnloadEvent) => {
      if (!stateRef.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const clearRecovery = () => {
      const storage = portalRecoveryStorage();
      if (storage) clearPortalRecoveryForUser(storage, props.userId);
      setRecoveryCandidate(null);
    };
    window.addEventListener("beforeunload", protectUnload);
    window.addEventListener("portal-recovery-clear", clearRecovery);
    return () => {
      window.removeEventListener("beforeunload", protectUnload);
      window.removeEventListener("portal-recovery-clear", clearRecovery);
    };
  }, [props.userId]);

  const loadAssets = useCallback(async (city: string): Promise<PortalAsset[] | null> => {
    const generation = generationRef.current;
    const mutationSequence = assetMutationSequenceRef.current;
    const requestId = ++assetLoadRequestRef.current;
    const requestContextIsCurrent = () =>
      generationRef.current === generation
      && contextRef.current.city === city
      && assetLoadRequestRef.current === requestId;
    setAssetsLoading(true);
    try {
      const response = await fetch(assetUrl(city));
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      if (!requestContextIsCurrent()) return null;
      const next = replayAssetMutations(
        strictAssets(value),
        assetMutationLogRef.current.filter((mutation) =>
          mutation.sequence > mutationSequence),
      );
      setAssets(next);
      setAssetsLoadedCity(city);
      setSelectedAssetId((current) =>
        current && next.some(({ id }) => id === current) ? current : next[0]?.id ?? null);
      return next;
    } catch (caught) {
      if (!requestContextIsCurrent()) return null;
      setError(caught instanceof Error ? caught.message : "素材库加载失败");
      return null;
    } finally {
      if (requestContextIsCurrent()) setAssetsLoading(false);
    }
  }, []);

  const selectTool = useCallback((tool: EditorTool) => {
    setActiveTool(tool);
    const city = stateRef.current.city;
    if (
      ready
      && (tool === "页面设置" || tool === "素材库")
      && !assetsLoading
      && assetsLoadedCity !== city
    ) {
      void loadAssets(city);
    }
  }, [assetsLoadedCity, assetsLoading, loadAssets, ready]);

  const capture = useCallback((): CapturedContext => {
    const current = stateRef.current;
    return {
      city: current.city,
      viewport: current.viewport,
      revision: current.revision,
      scene: current.present,
      generation: generationRef.current,
      editVersion: current.editVersion,
    };
  }, []);

  const saveCaptured = useCallback(async (captured: CapturedContext) => {
    const response = await fetch(mutationUrl(captured.city, "draft"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        viewport: captured.viewport,
        revision: captured.revision,
        scene: captured.scene,
      }),
    });
    const value = await responseJson(response);
    if (!response.ok) throw responseError(response, value);
    return strictDraft(value, captured.viewport);
  }, []);

  const adoptSavedDraft = useCallback((captured: CapturedContext, draft: DraftPayload) => {
    if (!isCurrent(captured)) return false;
    const unchanged = stateRef.current.editVersion === captured.editVersion;
    dispatch({
      type: "MARK_SAVED",
      revision: draft.revision,
      scene: draft.scene,
      expectedEditVersion: captured.editVersion,
    });
    if (unchanged) {
      portalRecoveryStorage()?.removeItem(recoveryKey(
        props.userId,
        captured.city,
        captured.viewport,
      ));
    }
    setConflict(null);
    if (unchanged) setRecoveryCandidate(null);
    setReady(true);
    return unchanged ? "clean" : "dirty";
  }, [isCurrent, props.userId]);

  const handleSave = useCallback(async () => {
    if (
      cropTargetIdRef.current
      || !ready
      || busy === "saving"
      || busy === "publishing"
    ) return;
    const captured = capture();
    const busyToken = beginBusy("saving");
    setError("");
    setStatus("正在保存草稿…");
    try {
      const draft = await saveCaptured(captured);
      const adoption = adoptSavedDraft(captured, draft);
      if (!adoption) return;
      setStatus(adoption === "clean"
        ? `${captured.viewport === "DESKTOP" ? "桌面" : "手机"}草稿已保存`
        : "保存期间产生了新修改，后续修改仍未保存");
    } catch (caught) {
      if (!isCurrent(captured)) return;
      const workflowError = caught instanceof WorkflowError
        ? caught
        : new WorkflowError(caught instanceof Error ? caught.message : "草稿保存失败");
      if (workflowError.status === 409 || workflowError.code === "DRAFT_CONFLICT") {
        const current = stateRef.current;
        setConflict({
          ...captured,
          revision: current.revision,
          scene: current.present,
          editVersion: current.editVersion,
          message: workflowError.message,
        });
      }
      setError(workflowError.message);
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [
    adoptSavedDraft,
    beginBusy,
    busy,
    capture,
    endBusy,
    isCurrent,
    ready,
    saveCaptured,
  ]);

  const ensureSaved = useCallback(async () => {
    const current = stateRef.current;
    if (!current.dirty) {
      return {
        city: current.city,
        viewport: current.viewport,
        revision: current.revision,
        generation: generationRef.current,
      };
    }
    const captured = capture();
    const draft = await saveCaptured(captured);
    const adoption = adoptSavedDraft(captured, draft);
    if (!adoption) throw new WorkflowError("保存期间上下文已切换");
    if (adoption === "dirty") {
      throw new WorkflowError("保存期间产生了新修改，请再次保存后再继续");
    }
    return {
      city: captured.city,
      viewport: captured.viewport,
      revision: draft.revision,
      generation: captured.generation,
    };
  }, [adoptSavedDraft, capture, saveCaptured]);

  const handleCopyDesktopToMobile = useCallback(async () => {
    if (
      cropTargetIdRef.current
      || !ready
      || busy === "saving"
      || busy === "publishing"
    ) return;
    if (stateRef.current.viewport !== "DESKTOP") {
      setError("请先切换到桌面画布，再复制到手机");
      return;
    }
    if (
      !window.confirm("将用当前桌面草稿生成手机初稿，并覆盖该城市的手机草稿。确认继续吗？")
    ) {
      setStatus("已取消复制桌面到手机");
      return;
    }
    // Capture op context once; catch/stale checks must not re-read live refs.
    const opContext = {
      city: contextRef.current.city,
      viewport: contextRef.current.viewport,
      generation: generationRef.current,
    };
    const busyToken = beginBusy("saving");
    setError("");
    setStatus("正在保存桌面并复制到手机…");
    try {
      const desktop = await ensureSaved();
      if (
        generationRef.current !== desktop.generation
        || contextRef.current.city !== desktop.city
        || !isCurrent(opContext)
      ) return;
      const mobileDraft = await fetchDraft({ city: desktop.city, viewport: "MOBILE" });
      if (
        generationRef.current !== desktop.generation
        || contextRef.current.city !== desktop.city
        || !isCurrent(opContext)
      ) return;
      const response = await fetch(mutationUrl(desktop.city, "draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "COPY_DESKTOP_TO_MOBILE",
          revisions: {
            desktop: desktop.revision,
            mobile: mobileDraft.revision,
          },
        }),
      });
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      if (
        generationRef.current !== desktop.generation
        || contextRef.current.city !== desktop.city
        || !isCurrent(opContext)
      ) return;
      endBusy(busyToken);
      await loadContext(
        { city: desktop.city, viewport: "MOBILE" },
        { ignoreRecovery: true },
      );
      if (
        contextRef.current.city === desktop.city
        && contextRef.current.viewport === "MOBILE"
      ) {
        setStatus("已复制并约束到手机画布；请检查手机版后再发布");
      }
      return;
    } catch (caught) {
      if (!isCurrent(opContext)) return;
      const workflowError = caught instanceof WorkflowError
        ? caught
        : new WorkflowError(caught instanceof Error ? caught.message : "复制桌面到手机失败");
      if (workflowError.status === 409 || workflowError.code === "DRAFT_CONFLICT") {
        setConflict({
          city: opContext.city,
          viewport: opContext.viewport,
          revision: stateRef.current.revision,
          scene: stateRef.current.present,
          generation: opContext.generation,
          editVersion: stateRef.current.editVersion,
          message: workflowError.message,
        });
      }
      setError(workflowError.message);
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, busy, endBusy, ensureSaved, isCurrent, loadContext, ready]);

  const handleOpenHistory = useCallback(async () => {
    if (cropTargetIdRef.current || !ready) return;
    const city = stateRef.current.city;
    const generation = generationRef.current;
    // Every open (including same-city reopen) gets a new sequence id + abort signal.
    historyAbortRef.current?.abort();
    const requestId = ++historyRequestIdRef.current;
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryScope({ city, generation });
    setHistoryEntries([]);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/portal/${encodeURIComponent(city)}/history`,
        { signal: controller.signal },
      );
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      if (
        historyRequestIdRef.current !== requestId
        || generationRef.current !== generation
        || contextRef.current.city !== city
      ) return;
      const history = typeof value === "object" && value !== null && Array.isArray((value as { history?: unknown }).history)
        ? (value as { history: unknown[] }).history
        : [];
      setHistoryEntries(history.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Partial<PortalHistoryEntry>;
        if (!Number.isInteger(record.version) || Number(record.version) < 1) return [];
        return [{
          version: Number(record.version),
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          publishedBySnapshot: record.publishedBySnapshot ?? null,
        }];
      }));
      setHistoryScope({ city, generation });
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (
        historyRequestIdRef.current !== requestId
        || generationRef.current !== generation
        || contextRef.current.city !== city
      ) return;
      setError(caught instanceof Error ? caught.message : "历史版本加载失败");
      setHistoryEntries([]);
      setHistoryScope(null);
    } finally {
      if (
        historyRequestIdRef.current === requestId
        && generationRef.current === generation
        && contextRef.current.city === city
      ) {
        setHistoryLoading(false);
      }
    }
  }, [ready]);

  const handleRestoreHistory = useCallback(async (version: number) => {
    if (
      cropTargetIdRef.current
      || !ready
      || busy === "saving"
      || busy === "publishing"
    ) return;
    const opContext = {
      city: contextRef.current.city,
      viewport: contextRef.current.viewport,
      generation: generationRef.current,
    };
    if (
      !historyScope
      || historyScope.city !== opContext.city
      || historyScope.generation !== opContext.generation
    ) {
      setError("历史列表已过期，请重新打开历史");
      closeHistoryPanel();
      return;
    }
    if (!window.confirm(`将版本 ${version} 的当前设备场景恢复为新草稿。确认继续吗？`)) {
      setStatus("已取消历史恢复");
      return;
    }
    const busyToken = beginBusy("saving");
    setError("");
    setStatus(`正在恢复版本 ${version}…`);
    try {
      const current = await ensureSaved();
      if (
        generationRef.current !== current.generation
        || contextRef.current.city !== current.city
        || contextRef.current.viewport !== current.viewport
        || !isCurrent(opContext)
        || historyScope.city !== current.city
        || historyScope.generation !== opContext.generation
      ) return;
      const response = await fetch(
        `/api/admin/portal/${encodeURIComponent(current.city)}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            viewport: current.viewport,
            version,
            revision: current.revision,
          }),
        },
      );
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      const draft = strictDraft(value, current.viewport);
      if (
        generationRef.current !== current.generation
        || contextRef.current.city !== current.city
        || contextRef.current.viewport !== current.viewport
        || !isCurrent(opContext)
      ) return;
      dispatch({
        type: "LOAD_CONTEXT",
        city: current.city,
        viewport: current.viewport,
        revision: draft.revision,
        scene: draft.scene,
      });
      closeHistoryPanel();
      setReady(true);
      setStatus(`版本 ${version} 已恢复为新草稿`);
    } catch (caught) {
      if (!isCurrent(opContext)) return;
      const workflowError = caught instanceof WorkflowError
        ? caught
        : new WorkflowError(caught instanceof Error ? caught.message : "历史恢复失败");
      if (workflowError.status === 409 || workflowError.code === "DRAFT_CONFLICT") {
        setConflict({
          city: opContext.city,
          viewport: opContext.viewport,
          revision: stateRef.current.revision,
          scene: stateRef.current.present,
          generation: opContext.generation,
          editVersion: stateRef.current.editVersion,
          message: workflowError.message,
        });
      }
      setError(workflowError.message);
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, busy, closeHistoryPanel, endBusy, ensureSaved, historyScope, isCurrent, ready]);

  const switchContext = useCallback((next: EditorContext) => {
    if (cropTargetIdRef.current) return;
    const current = stateRef.current;
    if (current.city === next.city && current.viewport === next.viewport) return;
    if (
      current.dirty
      && !window.confirm("当前画布有未保存修改，确定离开并载入目标画布吗？")
    ) return;
    void loadContext(next);
  }, [loadContext]);

  const loadConflictServer = useCallback(async () => {
    if (!conflict || !isCurrent(conflict)) return;
    const storage = portalRecoveryStorage();
    storage?.removeItem(recoveryKey(
      props.userId,
      conflict.city,
      conflict.viewport,
    ));
    await loadContext(
      { city: conflict.city, viewport: conflict.viewport },
      { ignoreRecovery: true },
    );
  }, [conflict, isCurrent, loadContext, props.userId]);

  const reapplyConflictLocal = useCallback(async () => {
    if (!conflict || !isCurrent(conflict)) return;
    const current = stateRef.current;
    const captured = {
      ...conflict,
      revision: current.revision,
      scene: current.present,
      editVersion: current.editVersion,
    };
    const storage = portalRecoveryStorage();
    if (storage) {
      saveRecovery(
        storage,
        props.userId,
        captured.city,
        captured.viewport,
        captured.scene,
      );
    }
    const busyToken = beginBusy("loading");
    setError("");
    setStatus("正在载入服务器版本并重新套用本地副本…");
    try {
      const server = await fetchDraft(captured);
      if (!isCurrent(captured)) return;
      if (stateRef.current.editVersion !== captured.editVersion) {
        setError("重新套用期间产生了新修改，请重新处理冲突");
        setStatus("");
        return;
      }
      dispatch({
        type: "LOAD_CONTEXT",
        city: captured.city,
        viewport: captured.viewport,
        revision: server.revision,
        scene: server.scene,
      });
      dispatch({ type: "RESTORE_LOCAL", scene: captured.scene });
      setConflict(null);
      setReady(true);
      setStatus("本地副本已重新套用到最新服务器 revision，可重试保存");
    } catch (caught) {
      if (!isCurrent(captured)) return;
      setError(caught instanceof Error ? caught.message : "重新套用本地副本失败");
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, conflict, endBusy, isCurrent, props.userId]);

  const publishPair = useCallback(async (pending: PendingPublication) => {
    if (
      generationRef.current !== pending.generation
      || contextRef.current.city !== pending.city
    ) return;
    const response = await fetch(mutationUrl(pending.city, "publish"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisions: pending.revisions }),
    });
    const value = await responseJson(response);
    if (!response.ok) throw responseError(response, value);
    if (
      generationRef.current !== pending.generation
      || contextRef.current.city !== pending.city
    ) return;
    const version = typeof value === "object" && value !== null
      ? Number((value as { version?: unknown }).version)
      : Number.NaN;
    if (!Number.isInteger(version) || version < 1) {
      throw new WorkflowError("发布响应缺少有效版本号");
    }
    setPendingPublication(null);
    setStatus(`${CITY_LABELS[pending.city] ?? pending.city}门户版本 ${version} 已发布`);
    setError("");
  }, []);

  const handlePublish = useCallback(async () => {
    if (
      cropTargetIdRef.current
      || !ready
      || busy === "saving"
      || busy === "publishing"
    ) return;
    if (!window.confirm("将保存当前画布，并发布同一城市最新的桌面与手机草稿。确认继续吗？")) {
      setStatus("已取消发布；桌面和手机草稿均未发布");
      return;
    }
    const captured = capture();
    const busyToken = beginBusy("publishing");
    setError("");
    setStatus("正在保存当前画布并校验双端草稿…");
    try {
      const saved = await saveCaptured(captured);
      const adoption = adoptSavedDraft(captured, saved);
      if (!adoption) return;
      if (adoption === "dirty") {
        setError("保存期间产生了新修改，请再次保存并发布");
        setStatus("");
        return;
      }
      const publicationContext = {
        city: captured.city,
        generation: captured.generation,
      };
      const [desktop, mobile] = await Promise.all([
        fetchDraft({ city: captured.city, viewport: "DESKTOP" }),
        fetchDraft({ city: captured.city, viewport: "MOBILE" }),
      ]);
      if (
        generationRef.current !== publicationContext.generation
        || contextRef.current.city !== publicationContext.city
      ) return;
      if (stateRef.current.editVersion !== captured.editVersion) {
        setPendingPublication(null);
        setError("校验期间产生了新修改，请再次保存并发布");
        setStatus("");
        return;
      }
      const pending = {
        ...publicationContext,
        mobileReviewRequired: mobile.scene.requiresMobileReview,
        revisions: {
          desktop: desktop.revision,
          mobile: mobile.revision,
        },
      };
      setPendingPublication(pending);
      if (mobile.scene.requiresMobileReview) {
        setStatus("");
        setError("手机版需要人工审查");
        return;
      }
      await publishPair(pending);
    } catch (caught) {
      if (!isCurrent(captured)) return;
      const workflowError = caught instanceof WorkflowError
        ? caught
        : new WorkflowError(caught instanceof Error ? caught.message : "发布失败");
      if (workflowError.status === 409 || workflowError.code === "DRAFT_CONFLICT") {
        const current = stateRef.current;
        setConflict({
          ...captured,
          revision: current.revision,
          scene: current.present,
          editVersion: current.editVersion,
          message: workflowError.message,
        });
      }
      setError(workflowError.message);
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [
    adoptSavedDraft,
    beginBusy,
    busy,
    capture,
    endBusy,
    isCurrent,
    publishPair,
    ready,
    saveCaptured,
  ]);

  const confirmMobileReviewAndPublish = useCallback(async () => {
    const pending = pendingPublication;
    if (
      !pending
      || generationRef.current !== pending.generation
      || contextRef.current.city !== pending.city
      || contextRef.current.viewport !== "MOBILE"
      || !ready
    ) return;
    const reviewEditVersion = stateRef.current.editVersion;
    const busyToken = beginBusy("publishing");
    setError("");
    setStatus("正在确认手机版审查并发布…");
    try {
      const response = await fetch(mutationUrl(pending.city, "draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "CONFIRM_MOBILE_REVIEW",
          revision: pending.revisions.mobile,
        }),
      });
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      const mobile = strictDraft(value, "MOBILE");
      if (
        generationRef.current !== pending.generation
        || contextRef.current.city !== pending.city
        || contextRef.current.viewport !== "MOBILE"
      ) return;
      const unchanged = stateRef.current.editVersion === reviewEditVersion;
      dispatch({
        type: "MARK_SAVED",
        revision: mobile.revision,
        scene: mobile.scene,
        expectedEditVersion: reviewEditVersion,
      });
      if (!unchanged) {
        setPendingPublication(null);
        setError("确认期间产生了新修改，请重新保存并检查手机版");
        setStatus("");
        setReady(true);
        return;
      }
      portalRecoveryStorage()?.removeItem(recoveryKey(
        props.userId,
        pending.city,
        "MOBILE",
      ));
      const reviewed = {
        ...pending,
        mobileReviewRequired: false,
        revisions: { ...pending.revisions, mobile: mobile.revision },
      };
      setPendingPublication(reviewed);
      await publishPair(reviewed);
    } catch (caught) {
      if (
        generationRef.current !== pending.generation
        || contextRef.current.city !== pending.city
      ) return;
      if (stateRef.current.editVersion !== reviewEditVersion) {
        setPendingPublication(null);
        setError("确认期间产生了新修改，请重新保存并检查手机版");
        setStatus("");
        return;
      }
      setError(caught instanceof Error ? caught.message : "手机版审查确认失败");
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, endBusy, pendingPublication, props.userId, publishPair, ready]);

  const enterMobileReview = useCallback(() => {
    const pending = pendingPublication;
    if (
      !pending
      || !pending.mobileReviewRequired
      || generationRef.current !== pending.generation
      || contextRef.current.city !== pending.city
    ) return;
    void loadContext(
      { city: pending.city, viewport: "MOBILE" },
      { pendingPublication: pending },
    );
  }, [loadContext, pendingPublication]);

  const retryPublication = useCallback(async () => {
    const pending = pendingPublication;
    if (
      !pending
      || generationRef.current !== pending.generation
      || contextRef.current.city !== pending.city
    ) return;
    const busyToken = beginBusy("publishing");
    setError("");
    setStatus("正在重试发布…");
    try {
      await publishPair(pending);
    } catch (caught) {
      if (
        generationRef.current !== pending.generation
        || contextRef.current.city !== pending.city
      ) return;
      setError(caught instanceof Error ? caught.message : "发布重试失败");
      setStatus("");
    } finally {
      endBusy(busyToken);
    }
  }, [beginBusy, endBusy, pendingPublication, publishPair]);

  const restoreRecovery = useCallback(() => {
    if (!recoveryCandidate) return;
    dispatch({ type: "RESTORE_LOCAL", scene: recoveryCandidate });
    setRecoveryCandidate(null);
    setStatus("已恢复本地副本；保存前不会覆盖服务器草稿");
  }, [recoveryCandidate]);

  const ignoreRecovery = useCallback(() => {
    const current = stateRef.current;
    portalRecoveryStorage()?.removeItem(recoveryKey(
      props.userId,
      current.city,
      current.viewport,
    ));
    setRecoveryCandidate(null);
    setStatus("已忽略本地恢复副本");
  }, [props.userId]);

  const visibleCanvasCenter = useCallback(() => {
    const current = stateRef.current;
    const { canvasWidth, canvasHeight } = portalSceneCanvasSize(current.present);
    const scroller = stageScrollerRef.current;
    const frame = stageFrameRef.current;
    if (!scroller || !frame) return { x: canvasWidth / 2, y: canvasHeight / 2 };
    const scrollerRect = scroller.getBoundingClientRect();
    const designPlane = frame.querySelector<HTMLElement>('[data-testid="portal-design-plane"]');
    const frameRect = designPlane?.getBoundingClientRect() ?? frame.getBoundingClientRect();
    if (
      scrollerRect.width <= 0
      || scrollerRect.height <= 0
      || frameRect.width <= 0
      || frameRect.height <= 0
    ) return { x: canvasWidth / 2, y: canvasHeight / 2 };
    const visibleLeft = Math.max(frameRect.left, scrollerRect.left);
    const visibleRight = Math.min(frameRect.right, scrollerRect.right);
    const visibleTop = Math.max(frameRect.top, scrollerRect.top);
    const visibleBottom = Math.min(frameRect.bottom, scrollerRect.bottom);
    const visibleX = visibleLeft < visibleRight
      ? (visibleLeft + visibleRight) / 2
      : frameRect.left + frameRect.width / 2;
    const visibleY = visibleTop < visibleBottom
      ? (visibleTop + visibleBottom) / 2
      : frameRect.top + frameRect.height / 2;
    return {
      x: Math.min(canvasWidth, Math.max(0, (visibleX - frameRect.left) / current.zoom)),
      y: Math.min(canvasHeight, Math.max(0, (visibleY - frameRect.top) / current.zoom)),
    };
  }, []);

  const createElement = useCallback(async (type: PortalElementType) => {
    if (type === "FREEHAND") {
      setDrawTool("FREEHAND");
      setCropTargetId(null);
      setError("");
      setStatus("自由绘制模式：在画布上拖动画笔，Esc 退出");
      return;
    }
    setDrawTool(null);
    let current = stateRef.current;
    if (current.present.elements.length >= PORTAL_MAX_ELEMENTS) {
      setError(`画布最多只能包含 ${PORTAL_MAX_ELEMENTS} 个元素`);
      return;
    }
    let imageAsset = assets.find(({ inspectionStatus }) => inspectionStatus === "VALID");
    if (type === "IMAGE" && !imageAsset) {
      const city = current.city;
      const loaded = assetsLoadedCity === city ? assets : await loadAssets(city);
      if (stateRef.current.city !== city || !loaded) return;
      imageAsset = loaded.find(({ inspectionStatus }) => inspectionStatus === "VALID");
      if (!imageAsset) {
        setError("请先在素材库上传一张通过安全检查的图片，再添加图片组件");
        return;
      }
      current = stateRef.current;
    }
    const { canvasWidth, canvasHeight } = portalSceneCanvasSize(current.present);
    const created = createDefaultPortalElement(
      type,
      current.viewport,
      visibleCanvasCenter(),
      imageAsset?.id ?? "",
      imageAsset,
    );
    const element = {
      ...created,
      x: Math.min(canvasWidth - created.width, Math.max(0, created.x)),
      y: Math.min(canvasHeight - created.height, Math.max(0, created.y)),
      zIndex: current.present.elements.length,
    } as PortalElement;
    const candidate = portalSceneV1Schema.safeParse({
      ...current.present,
      elements: [...current.present.elements, element],
    });
    if (!candidate.success) {
      setError(candidate.error.issues[0]?.message ?? "无法创建规范组件");
      return;
    }
    setError("");
    dispatch({ type: "ADD_ELEMENT", element });
  }, [assets, assetsLoadedCity, loadAssets, visibleCanvasCenter]);

  const commitSelected = useCallback((patch: Partial<PortalElement>) => {
    if (cropTargetIdRef.current) return;
    const current = stateRef.current;
    const id = current.selection[0];
    const element = current.present.elements.find((candidate) => candidate.id === id);
    if (!element || element.locked) return;
    const candidate = portalSceneV1Schema.safeParse({
      ...current.present,
      elements: current.present.elements.map((item) =>
        item.id === id ? { ...item, ...patch } : item),
    });
    if (!candidate.success) {
      setError(candidate.error.issues[0]?.message ?? "属性值无效");
      return;
    }
    setError("");
    dispatch({ type: "COMMIT_ELEMENT", id, patch });
  }, []);

  const renameSelected = useCallback((name: string) => {
    if (cropTargetIdRef.current) return;
    const current = stateRef.current;
    const id = current.selection[0];
    const element = current.present.elements.find((candidate) => candidate.id === id);
    if (!element || element.locked) return;
    const candidate = portalSceneV1Schema.safeParse({
      ...current.present,
      elements: current.present.elements.map((item) =>
        item.id === id ? { ...item, name } : item),
    });
    if (!candidate.success) {
      setError(candidate.error.issues[0]?.message ?? "图层名称无效");
      return;
    }
    setError("");
    dispatch({ type: "RENAME_ELEMENT", id, name });
  }, []);

  const uploadAsset = useCallback(async (
    file: File,
    category: "BACKGROUND" | "LOGO" | "IMAGE",
  ) => {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError("仅支持 PNG、JPEG、WebP 和 GIF 图片");
      return null;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("门户素材不能超过 10 MiB");
      return null;
    }
    const city = stateRef.current.city;
    const generation = generationRef.current;
    const requestContextIsCurrent = () =>
      generationRef.current === generation
      && contextRef.current.city === city;
    const form = new FormData();
    form.set("file", file);
    form.set("category", category);
    setUploading(true);
    setAssetsLoading(false);
    setError("");
    try {
      const response = await fetch(assetUrl(city), { method: "POST", body: form });
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      const asset = uploadedAsset(value);
      assetMutationLogRef.current.push({
        sequence: ++assetMutationSequenceRef.current,
        type: "UPSERT",
        asset,
      });
      setAssets((current) => [asset, ...current.filter(({ id }) => id !== asset.id)]);
      if (requestContextIsCurrent()) {
        setAssetsLoadedCity(city);
        setSelectedAssetId(asset.id);
        if (category === "BACKGROUND") {
          dispatch({
            type: "UPDATE_BACKGROUND",
            patch: { assetId: asset.id, naturalWidth: asset.width, naturalHeight: asset.height },
          });
        }
        setStatus(`${asset.originalName} 已上传`);
      }
      return asset;
    } catch (caught) {
      if (!requestContextIsCurrent()) return null;
      setError(caught instanceof Error ? caught.message : "素材上传失败");
      return null;
    } finally {
      if (requestContextIsCurrent()) setUploading(false);
    }
  }, []);

  const uploadImageToCanvas = useCallback(async (file: File) => {
    const captured = {
      city: stateRef.current.city,
      viewport: stateRef.current.viewport,
      generation: generationRef.current,
    };
    // Freeze the intended insertion point before the asynchronous upload. Browser
    // focus/layout changes around the native file picker must not move the result.
    const insertionCenter = visibleCanvasCenter();
    if (stateRef.current.present.elements.length >= PORTAL_MAX_ELEMENTS) {
      setError(`画布最多只能包含 ${PORTAL_MAX_ELEMENTS} 个元素`);
      return;
    }
    const asset = await uploadAsset(file, "IMAGE");
    if (!asset || !isCurrent(captured)) return;
    const current = stateRef.current;
    if (current.present.elements.length >= PORTAL_MAX_ELEMENTS) {
      setError(`图片已上传到素材库，但画布最多只能包含 ${PORTAL_MAX_ELEMENTS} 个元素`);
      return;
    }
    const { canvasWidth, canvasHeight } = portalSceneCanvasSize(current.present);
    const created = createDefaultPortalElement(
      "IMAGE",
      current.viewport,
      insertionCenter,
      asset.id,
      asset,
    );
    const element = {
      ...created,
      x: Math.min(canvasWidth - created.width, Math.max(0, created.x)),
      y: Math.min(canvasHeight - created.height, Math.max(0, created.y)),
      zIndex: current.present.elements.length,
    } as PortalElement;
    const candidate = portalSceneV1Schema.safeParse({
      ...current.present,
      elements: [...current.present.elements, element],
    });
    if (!candidate.success) {
      setError(candidate.error.issues[0]?.message ?? "图片已上传，但无法添加到画布");
      return;
    }
    dispatch({ type: "ADD_ELEMENT", element });
    setSelectedAssetId(asset.id);
    setError("");
    setStatus(`${asset.originalName} 已上传并添加到画布`);
  }, [isCurrent, uploadAsset, visibleCanvasCenter]);

  const deleteAsset = useCallback(async (asset: PortalAsset) => {
    const localScene = stateRef.current.present;
    if (
      localScene.background.assetId === asset.id
      || localScene.elements.some((element) =>
        element.type === "IMAGE" && element.assetId === asset.id)
    ) {
      setError("该素材仍被当前本地画布引用，不能删除；请先替换或移除引用");
      return;
    }
    if (
      asset.unused
      && !window.confirm(`确定永久删除未使用素材“${asset.originalName}”吗？`)
    ) return;
    const city = stateRef.current.city;
    const generation = generationRef.current;
    const requestContextIsCurrent = () =>
      generationRef.current === generation
      && contextRef.current.city === city;
    setAssetsLoading(false);
    setError("");
    try {
      const response = await fetch(assetUrl(city, asset.id), { method: "DELETE" });
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      assetMutationLogRef.current.push({
        sequence: ++assetMutationSequenceRef.current,
        type: "DELETE",
        assetId: asset.id,
      });
      setAssets((current) => current.filter(({ id }) => id !== asset.id));
      setSelectedAssetId((current) => current === asset.id ? null : current);
      if (requestContextIsCurrent()) setStatus(`${asset.originalName} 已删除`);
    } catch (caught) {
      if (!requestContextIsCurrent()) return;
      setError(caught instanceof Error ? caught.message : "素材删除失败");
    }
  }, []);

  const chooseAsset = useCallback((asset: PortalAsset) => {
    const current = stateRef.current;
    const element = current.present.elements.find(({ id }) => id === current.selection[0]);
    if (element?.type === "IMAGE") {
      commitSelected({ assetId: asset.id } as Partial<PortalElement>);
    } else {
      dispatch({
        type: "UPDATE_BACKGROUND",
        patch: { assetId: asset.id, naturalWidth: asset.width, naturalHeight: asset.height },
      });
    }
    setSelectedAssetId(asset.id);
  }, [commitSelected]);

  const fitStage = useCallback(() => {
    const current = stateRef.current;
    const { canvasWidth, canvasHeight } = portalSceneCanvasSize(current.present);
    const scroller = stageScrollerRef.current;
    if (!scroller || scroller.clientWidth <= 80 || scroller.clientHeight <= 80) {
      dispatch({ type: "SET_ZOOM", zoom: current.viewport === "MOBILE" ? 0.72 : 0.5 });
      return;
    }
    dispatch({
      type: "SET_ZOOM",
      zoom: Math.min(
        (scroller.clientWidth - 80) / canvasWidth,
        current.present.background.fitMode === "AUTO_HEIGHT"
          ? Number.POSITIVE_INFINITY
          : (scroller.clientHeight - 80) / canvasHeight,
      ),
    });
  }, []);

  const handleEditorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
      if (cropTargetIdRef.current) return;
      if (event.key === "Escape" && drawTool) {
        setDrawTool(null);
        setStatus("");
        event.preventDefault();
        return;
      }
      if (
        isInteractiveEditorTarget(event.target)
        || isInteractiveEditorTarget(document.activeElement)
      ) return;
      const current = stateRef.current;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
        const id = current.selection[0];
        const element = current.present.elements.find((candidate) => candidate.id === id);
        if (!element || element.locked) return;
        const distance = event.shiftKey ? 10 : 1;
        const x = element.x + (key === "arrowleft" ? -distance : key === "arrowright" ? distance : 0);
        const y = element.y + (key === "arrowup" ? -distance : key === "arrowdown" ? distance : 0);
        try {
          const normalized = normalizePortalScene(current.viewport, {
            ...current.present,
            elements: current.present.elements.map((candidate) =>
              candidate.id === id ? { ...candidate, x, y } : candidate),
          });
          const moved = normalized.elements.find((candidate) => candidate.id === id);
          if (moved) dispatch({ type: "COMMIT_ELEMENT", id, patch: { x: moved.x, y: moved.y } });
        } catch {
          setError("元素无法继续移出画布");
        }
        event.preventDefault();
        return;
      }
      const shortcut = modifier && ["c", "v", "d", "z", "y"].includes(key)
        || key === "delete"
        || key === "backspace";
      if (!shortcut) return;
      dispatch({
        type: "SHORTCUT",
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      });
      event.preventDefault();
  }, [drawTool]);

  const focusShortcutScope = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isInteractiveEditorTarget(event.target)) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }, []);

  const handleBack = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (
      stateRef.current.dirty
      && !window.confirm("当前画布有未保存修改，确定返回指南管理吗？")
    ) {
      event.preventDefault();
    }
  }, []);

  const cityLabel = CITY_LABELS[state.city] ?? state.city;
  const mutationBusy = busy === "saving" || busy === "publishing";
  /** City/device switches disabled during save/copy/restore (not plain draft load). */
  const contextSwitchLocked = mutationBusy || cropTargetId !== null;
  const selectedElement = useMemo(
    () => state.present.elements.find(({ id }) => id === state.selection[0]) ?? null,
    [state.present.elements, state.selection],
  );
  const focusElement = useCallback((id: string) => {
    window.requestAnimationFrame(() => {
      [...document.querySelectorAll<HTMLElement>("[data-portal-element-id]")]
        .find((node) => node.dataset.portalElementId === id)
        ?.focus();
    });
  }, []);

  return (
    <main className={styles.editor} aria-label="四城门户可视化编辑器">
      <header className={styles.toolbar} aria-label="编辑器工具栏">
        <Link className={styles.backLink} href="/admin/guides" onClick={handleBack}>
          <span aria-hidden="true">←</span>
          返回指南管理
        </Link>
        <div className={styles.context}>
          <span>城市</span>
          <div role="group" aria-label="编辑城市">
            {CITIES.map(([city, label]) => (
              <button
                key={city}
                type="button"
                disabled={contextSwitchLocked}
                aria-pressed={state.city === city}
                onClick={() => switchContext({ city, viewport: stateRef.current.viewport })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.viewportSwitch} role="group" aria-label="设备视口">
          <button
            type="button"
            disabled={contextSwitchLocked}
            aria-pressed={state.viewport === "DESKTOP"}
            onClick={() => switchContext({ city: stateRef.current.city, viewport: "DESKTOP" })}
          >
            桌面
          </button>
          <button
            type="button"
            disabled={contextSwitchLocked}
            aria-pressed={state.viewport === "MOBILE"}
            onClick={() => switchContext({ city: stateRef.current.city, viewport: "MOBILE" })}
          >
            手机
          </button>
        </div>
        <EditorToolbar
          state={state}
          dispatch={dispatch}
          onFit={fitStage}
          disabled={cropTargetId !== null}
        />
        <div className={styles.saveActions}>
          <button
            type="button"
            disabled={!ready || mutationBusy || cropTargetId !== null}
            aria-pressed={previewOpen}
            onClick={() => setPreviewOpen((open) => !open)}
          >
            {previewOpen ? "退出预览" : "预览"}
          </button>
          <button
            type="button"
            disabled={!ready || mutationBusy || cropTargetId !== null || state.viewport !== "DESKTOP"}
            onClick={() => void handleCopyDesktopToMobile()}
          >
            复制桌面到手机
          </button>
          <button
            type="button"
            disabled={!ready || mutationBusy || cropTargetId !== null}
            aria-pressed={historyOpen}
            onClick={() => {
              if (historyOpen) {
                closeHistoryPanel();
                return;
              }
              void handleOpenHistory();
            }}
          >
            历史
          </button>
          <button
            type="button"
            disabled={!ready || mutationBusy || cropTargetId !== null}
            aria-busy={busy === "saving"}
            onClick={() => void handleSave()}
          >
            保存
          </button>
          <button
            className={styles.publishButton}
            type="button"
            disabled={!ready || mutationBusy || cropTargetId !== null}
            aria-busy={busy === "publishing"}
            onClick={() => void handlePublish()}
          >
            保存并发布
          </button>
        </div>
      </header>

      {(status || error || conflict || recoveryCandidate || pendingPublication) && (
        <section className={styles.workflowNotice} aria-live="polite">
          {status && <p role="status">{status}</p>}
          {error && <p role="alert">{error}</p>}
          {!ready && busy !== "loading" && (
            <button
              type="button"
              onClick={() => void loadContext(contextRef.current)}
            >
              重试加载
            </button>
          )}
          {conflict && (
            <div>
              <button type="button" onClick={() => void loadConflictServer()}>
                载入服务器版本
              </button>
              <button type="button" onClick={() => void reapplyConflictLocal()}>
                暂存本地副本后重新套用
              </button>
            </div>
          )}
          {!conflict && state.dirty && status.includes("重新套用") && (
            <button type="button" onClick={() => void handleSave()}>
              重试保存
            </button>
          )}
          {recoveryCandidate && (
            <div>
              <p>发现此画布的本地恢复副本</p>
              <button type="button" onClick={restoreRecovery}>恢复本地副本</button>
              <button type="button" onClick={ignoreRecovery}>忽略本地副本</button>
            </div>
          )}
          {pendingPublication?.mobileReviewRequired && (
            state.viewport === "MOBILE"
              && ready
              ? (
                  <button
                    type="button"
                    disabled={mutationBusy}
                    onClick={() => void confirmMobileReviewAndPublish()}
                  >
                    已检查手机版，继续发布
                  </button>
                )
              : (
                  <button
                    type="button"
                    disabled={mutationBusy}
                    onClick={enterMobileReview}
                  >
                    进入手机版检查
                  </button>
                )
          )}
          {pendingPublication && !pendingPublication.mobileReviewRequired && error && (
            <button
              type="button"
              disabled={mutationBusy}
              onClick={() => void retryPublication()}
            >
              重试发布
            </button>
          )}
        </section>
      )}

      <div className={styles.workspace}>
        <nav className={styles.toolRail} aria-label="编辑工具">
          <p>工具</p>
          {TOOL_LABELS.map((label, index) => (
            <button
              key={label}
              type="button"
              disabled={cropTargetId !== null}
              aria-current={activeTool === label ? "page" : undefined}
              aria-controls="editor-tool-panel"
              onClick={() => selectTool(label)}
            >
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              {label}
            </button>
          ))}
          <fieldset
            id="editor-tool-panel"
            className={styles.toolPanel}
            disabled={cropTargetId !== null}
          >
            {activeTool === "添加组件" && (
              <ComponentPanel
                disabled={!ready}
                uploading={uploading}
                onCreate={createElement}
                onUploadImage={uploadImageToCanvas}
              />
            )}
            {activeTool === "页面设置" && (
              <PagePanel
                background={state.present.background}
                assets={assets}
                loading={assetsLoading}
                uploading={uploading}
                dispatch={dispatch}
                onUpload={uploadAsset}
              />
            )}
            {activeTool === "素材库" && (
              <AssetPanel
                assets={assets}
                loading={assetsLoading}
                uploading={uploading}
                selectedElementIsImage={selectedElement?.type === "IMAGE"}
                selectedAssetId={selectedAssetId}
                onSelectedAssetId={setSelectedAssetId}
                onChoose={chooseAsset}
                onUpload={uploadAsset}
                onDelete={deleteAsset}
              />
            )}
            {activeTool === "图层" && (
              <LayerPanel
                scene={state.present}
                selection={state.selection}
                dispatch={dispatch}
                onFocusElement={focusElement}
              />
            )}
          </fieldset>
        </nav>

        <section
          className={styles.stageRegion}
          aria-label="画布工作区"
          tabIndex={0}
          onKeyDown={handleEditorKeyDown}
          onPointerDown={focusShortcutScope}
        >
          <div className={styles.stageHeader}>
            <div>
              <strong>{cityLabel}门户</strong>
              <span>{(() => {
                const size = portalSceneCanvasSize(state.present);
                return `${size.canvasWidth} × ${Math.round(size.canvasHeight)}`;
              })()}</span>
            </div>
            <span>{Math.round(state.zoom * 100)}%</span>
          </div>
          <div ref={stageScrollerRef} className={styles.stageScroller}>
            <div ref={stageFrameRef} className={styles.stageFrame}>
              <EditorStage
                key={cropTargetId ?? "standard-editor-stage"}
                className={styles.stage}
                state={state}
                dispatch={dispatch}
                cropTargetId={cropTargetId}
                onCropExit={finishCrop}
                drawTool={drawTool}
                onFreehandComplete={() => {
                  setDrawTool(null);
                  setStatus("自由路径已创建并选中");
                }}
              />
            </div>
          </div>
        </section>

        <aside className={styles.properties} aria-label="属性面板">
          <header>
            <p>INSPECTOR</p>
            <h2>属性</h2>
          </header>
          <PropertyPanel
            element={selectedElement}
            assets={assets}
            cropActive={cropTargetId === selectedElement?.id}
            cropDisabled={!ready || mutationBusy}
            onStartCrop={startCrop}
            onCommit={commitSelected}
            onRename={renameSelected}
            onHidden={(hidden) => {
              if (selectedElement) dispatch({
                type: "SET_ELEMENT_HIDDEN",
                id: selectedElement.id,
                hidden,
              });
            }}
            onLocked={(locked) => {
              if (selectedElement) dispatch({
                type: "SET_ELEMENT_LOCKED",
                id: selectedElement.id,
                locked,
              });
            }}
          />
        </aside>
      </div>

      {previewOpen && (
        <div className={styles.previewOverlay} role="dialog" aria-label="员工预览">
          <div className={styles.previewHeader}>
            <div>
              <p>预览（未发布）</p>
              <strong>{cityLabel} · {state.viewport === "DESKTOP" ? "桌面" : "手机"}</strong>
            </div>
            <button type="button" onClick={() => setPreviewOpen(false)}>退出预览</button>
          </div>
          <div className={styles.previewBody}>
            <PublishedScene scene={state.present} version={0} />
          </div>
        </div>
      )}

      {historyOpen && (
        <div className={styles.historyPanel} role="dialog" aria-label="发布历史" aria-modal="true">
          <div className={styles.historyHeader}>
            <strong id="portal-history-title">发布历史</strong>
            <button
              type="button"
              aria-label="关闭发布历史"
              onClick={() => closeHistoryPanel()}
            >
              关闭
            </button>
          </div>
          {historyLoading && <p role="status">正在加载历史…</p>}
          {!historyLoading && historyEntries.length === 0 && (
            <p>暂无发布历史</p>
          )}
          <ul className={styles.historyList}>
            {historyEntries.map((entry) => (
              <li key={entry.version}>
                <div>
                  <strong>版本 {entry.version}</strong>
                  <span>{entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN") : "时间未知"}</span>
                </div>
                <button
                  type="button"
                  disabled={mutationBusy}
                  aria-label={`恢复版本 ${entry.version}`}
                  onClick={() => void handleRestoreHistory(entry.version)}
                >
                  恢复为草稿
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

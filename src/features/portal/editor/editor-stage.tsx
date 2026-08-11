"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { Layer, Line, Rect, Stage } from "react-konva";

import {
  ElementNode,
  type SnapGuide,
} from "@/features/portal/editor/element-node";
import {
  appendFreehandPoint,
  buildFreehandElementFromStroke,
  FREEHAND_DEFAULT_STROKE,
  FREEHAND_DEFAULT_STROKE_WIDTH,
  FREEHAND_DEFAULT_TENSION,
  scaleFreehandElementGeometry,
  type AbsolutePoint,
} from "@/features/portal/editor/freehand-drawing";
import {
  initialCropForSession,
  panCrop,
  resetCrop,
  zoomCrop,
  type NormalizedCrop,
} from "@/features/portal/editor/image-crop";
import { TextOverlay } from "@/features/portal/editor/text-overlay";
import type { EditorAction, EditorState } from "@/features/portal/editor/editor-types";
import { elementBounds, portalCanvasSize, portalSceneCanvasSize } from "@/features/portal/portal-geometry";
import {
  normalizePortalScene,
  type PortalElement,
  type PortalSceneV1,
  type PortalViewportInput,
} from "@/features/portal/portal-scene";

const SNAP_THRESHOLD = 5;
const defaultAssetUrlForId = (assetId: string) =>
  `/api/files/${encodeURIComponent(assetId)}`;
const noop = () => undefined;

/**
 * Geometry adjustment chrome is a CSS-pixel overlay OUTSIDE the overflow:hidden
 * 门户画布 clip. gap/padding/border/radius stay fixed CSS values; placement is in
 * host CSS coordinates (design × zoom). The host uses overflow:visible so zoom 0.1
 * still keeps all 6 buttons unclipped even when the strip is wider than the stage.
 */
export const ADJUSTMENT_CHROME = {
  buttonSize: 30,
  gap: 4,
  padding: 4,
  border: 1,
  radius: 6,
  count: 6,
  offsetBelow: 8,
} as const;

export function adjustmentGroupCssSize() {
  const { buttonSize, gap, padding, border, count } = ADJUSTMENT_CHROME;
  return {
    width: padding * 2 + border * 2 + count * buttonSize + (count - 1) * gap,
    height: padding * 2 + border * 2 + buttonSize,
  };
}

/** Place the fixed-CSS adjustment strip in host CSS pixels (design × zoom). */
export function clampAdjustmentGroupCssPosition(
  selected: { x: number; y: number; height: number },
  canvas: { width: number; height: number },
  zoom: number,
) {
  const safeZoom = Math.max(0.1, zoom);
  const { width, height } = adjustmentGroupCssSize();
  const hostWidth = canvas.width * safeZoom;
  const hostHeight = canvas.height * safeZoom;
  const preferredLeft = selected.x * safeZoom;
  const preferredTop = (selected.y + selected.height) * safeZoom + ADJUSTMENT_CHROME.offsetBelow;
  // Prefer on-stage placement when the strip fits; otherwise pin to origin and allow
  // overflow:visible host to keep buttons outside the canvas box (not clipped).
  const maxLeft = Math.max(0, hostWidth - width);
  const maxTop = Math.max(0, hostHeight - height);
  return {
    left: Math.max(0, Math.min(preferredLeft, maxLeft)),
    top: Math.max(0, Math.min(preferredTop, maxTop)),
    width,
    height,
    hostWidth,
    hostHeight,
  };
}

const GEOMETRY_ADJUSTMENTS = [
  {
    id: "width-decrease",
    label: "宽度减少 1 像素",
    text: "宽−",
    patch: (element: PortalElement) => ({ width: element.width - 1 }),
  },
  {
    id: "width-increase",
    label: "宽度增加 1 像素",
    text: "宽+",
    patch: (element: PortalElement) => ({ width: element.width + 1 }),
  },
  {
    id: "height-decrease",
    label: "高度减少 1 像素",
    text: "高−",
    patch: (element: PortalElement) => ({ height: element.height - 1 }),
  },
  {
    id: "height-increase",
    label: "高度增加 1 像素",
    text: "高+",
    patch: (element: PortalElement) => ({ height: element.height + 1 }),
  },
  {
    id: "rotation-decrease",
    label: "逆时针旋转 1 度",
    text: "↶",
    patch: (element: PortalElement) => ({ rotation: element.rotation - 1 }),
  },
  {
    id: "rotation-increase",
    label: "顺时针旋转 1 度",
    text: "↷",
    patch: (element: PortalElement) => ({ rotation: element.rotation + 1 }),
  },
] as const;

export type EditorStageProps = {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  className?: string;
  assetUrlForId?(assetId: string): string;
  cropTargetId?: string | null;
  onCropExit?(): void;
  /** Independent freehand brush tool (not a line dash style). */
  drawTool?: "FREEHAND" | null;
  freehandStyle?: {
    stroke?: string;
    strokeWidth?: number;
    tension?: number;
    opacity?: number;
  };
  onFreehandComplete?(): void;
};

type CropSession = {
  targetId: string;
  assetId: string;
  fitMode: "CONTAIN" | "COVER";
  source: { width: number; height: number };
  frame: { width: number; height: number };
  resetCrop: NormalizedCrop;
  currentCrop: NormalizedCrop;
};

type CropFailure = {
  targetId: string;
  message: string;
};

export type SnapResult = {
  patch: Pick<PortalElement, "x" | "y">;
  guides: SnapGuide[];
};

export function normalizeTransformedElement(
  scene: PortalSceneV1,
  element: PortalElement,
  patch: Pick<PortalElement, "x" | "y" | "width" | "height" | "rotation">,
) {
  try {
    const nextElement = element.type === "FREEHAND"
      ? scaleFreehandElementGeometry(element, patch)
      : { ...element, ...patch };
    const normalized = normalizePortalScene(scene.viewport, {
      ...scene,
      elements: scene.elements.map((candidate) =>
        candidate.id === element.id ? nextElement : candidate),
    });
    return normalized.elements.find((candidate) => candidate.id === element.id) ?? nextElement;
  } catch {
    return element.type === "FREEHAND"
      ? scaleFreehandElementGeometry(element, patch)
      : element;
  }
}

function alignmentPoints(start: number, size: number) {
  return [start, start + size / 2, start + size] as const;
}

export function snapElementPosition(
  element: PortalElement,
  position: { x: number; y: number },
  otherElements: PortalElement[],
  viewport: PortalViewportInput,
  enabled = true,
  canvasOverride?: { canvasWidth: number; canvasHeight: number },
): SnapResult {
  const { canvasWidth, canvasHeight } = canvasOverride ?? portalCanvasSize(viewport);
  let patch = { x: position.x, y: position.y };

  let candidateBounds = elementBounds({ ...element, ...patch } as PortalElement);
  if (candidateBounds.x < 0) patch.x -= candidateBounds.x;
  if (candidateBounds.y < 0) patch.y -= candidateBounds.y;
  if (candidateBounds.x + candidateBounds.width > canvasWidth) {
    patch.x -= candidateBounds.x + candidateBounds.width - canvasWidth;
  }
  if (candidateBounds.y + candidateBounds.height > canvasHeight) {
    patch.y -= candidateBounds.y + candidateBounds.height - canvasHeight;
  }

  if (!enabled) return { patch, guides: [] };

  candidateBounds = elementBounds({ ...element, ...patch } as PortalElement);
  const verticalTargets = [0, canvasWidth / 2, canvasWidth];
  const horizontalTargets = [0, canvasHeight / 2, canvasHeight];
  for (const other of otherElements) {
    if (other.id === element.id || other.hidden || other.locked) continue;
    const bounds = elementBounds(other);
    verticalTargets.push(...alignmentPoints(bounds.x, bounds.width));
    horizontalTargets.push(...alignmentPoints(bounds.y, bounds.height));
  }

  const nearest = (
    movingPoints: readonly number[],
    targets: readonly number[],
  ): { delta: number; guide: number } | null => {
    let match: { delta: number; guide: number } | null = null;
    for (const movingPoint of movingPoints) {
      for (const guide of targets) {
        const delta = guide - movingPoint;
        if (Math.abs(delta) > SNAP_THRESHOLD) continue;
        if (!match || Math.abs(delta) < Math.abs(match.delta)) match = { delta, guide };
      }
    }
    return match;
  };

  const vertical = nearest(
    alignmentPoints(candidateBounds.x, candidateBounds.width),
    verticalTargets,
  );
  const horizontal = nearest(
    alignmentPoints(candidateBounds.y, candidateBounds.height),
    horizontalTargets,
  );
  const guides: SnapGuide[] = [];
  if (vertical) {
    patch = { ...patch, x: patch.x + vertical.delta };
    guides.push({ axis: "VERTICAL", value: vertical.guide });
  }
  if (horizontal) {
    patch = { ...patch, y: patch.y + horizontal.delta };
    guides.push({ axis: "HORIZONTAL", value: horizontal.guide });
  }
  return { patch, guides };
}

function elementLabel(element: PortalElement) {
  switch (element.type) {
    case "TEXT":
      return `文字：${element.text}`;
    case "RECT":
      return `矩形：${element.name}`;
    case "CIRCLE":
      return `圆形：${element.name}`;
    case "ELLIPSE":
      return `椭圆：${element.name}`;
    case "ROUND_RECT":
      return `圆角矩形：${element.name}`;
    case "TRIANGLE":
      return `三角形：${element.name}`;
    case "LINE":
      return `线条：${element.name}`;
    case "ARROW":
      return `箭头：${element.name}`;
    case "FREEHAND":
      return `自由绘制：${element.name}`;
    case "IMAGE":
      return `图片：${element.altText}`;
    case "ICON":
      return `图标：${element.name}`;
    case "BUTTON":
      return `按钮：${element.text}`;
    case "MARKER":
      return `标记：${element.name}`;
  }
}

export function EditorStage({
  state,
  dispatch,
  className,
  assetUrlForId = defaultAssetUrlForId,
  cropTargetId = null,
  onCropExit = noop,
  drawTool = null,
  freehandStyle,
  onFreehandComplete = noop,
}: EditorStageProps) {
  const [stageNode, setStageNode] = useState<Konva.Stage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);
  const [adjustmentFocusId, setAdjustmentFocusId] = useState<string | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [cropSession, setCropSession] = useState<CropSession | null>(null);
  const cropSessionRef = useRef<CropSession | null>(null);
  const cropKeyboardRef = useRef<HTMLDivElement | null>(null);
  const [cropFailure, setCropFailure] = useState<CropFailure | null>(null);
  const [draftStroke, setDraftStroke] = useState<AbsolutePoint[] | null>(null);
  const draftStrokeRef = useRef<AbsolutePoint[] | null>(null);
  const scene = state.transientPreview ?? state.present;
  const { canvasWidth, canvasHeight } = portalSceneCanvasSize(scene);
  const zoom = state.zoom;
  const freehandMode = drawTool === "FREEHAND" && !cropTargetId;
  const [previousFreehandMode, setPreviousFreehandMode] = useState(freehandMode);
  if (previousFreehandMode !== freehandMode) {
    setPreviousFreehandMode(freehandMode);
    if (!freehandMode && draftStroke !== null) setDraftStroke(null);
  }
  const visibleElements = useMemo(
    () => scene.elements
      .filter((element) => !element.hidden)
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id)),
    [scene.elements],
  );
  const backgroundUrl = scene.background.assetId ? assetUrlForId(scene.background.assetId) : null;

  const selectedId = state.selection[0] ?? null;
  const selected = visibleElements.find((element) => element.id === selectedId) ?? null;
  const editingElement = visibleElements.find(
    (element): element is Extract<PortalElement, { type: "TEXT" }> =>
      element.id === editingId && element.type === "TEXT",
  ) ?? null;
  const cropTarget = state.present.elements.find(
    (element): element is Extract<PortalElement, { type: "IMAGE" }> =>
      element.id === cropTargetId && element.type === "IMAGE",
  ) ?? null;
  const activeCropSession = cropSession?.targetId === cropTargetId
    && !cropTarget?.hidden
    && cropSession.assetId === cropTarget?.assetId
    && cropSession.fitMode === cropTarget.fitMode
    && cropSession.frame.width === cropTarget.width
    && cropSession.frame.height === cropTarget.height
    ? cropSession
    : null;
  const activeCropTargetId = activeCropSession?.targetId ?? null;
  const cropMessage = !cropTargetId
    ? null
    : !cropTarget
      ? "无法裁剪：请选择一张图片"
      : cropTarget.locked
        ? "无法裁剪：图片已锁定，请先解锁"
        : cropTarget.hidden
          ? "无法裁剪：图片已隐藏，请先设为可见"
        : cropFailure?.targetId === cropTargetId
          ? cropFailure.message
          : activeCropSession
            ? null
            : "正在加载裁剪图片…";

  useEffect(() => {
    cropSessionRef.current = cropSession;
  }, [cropSession]);

  useEffect(() => {
    if (activeCropTargetId) {
      cropKeyboardRef.current?.focus({ preventScroll: true });
    }
  }, [activeCropTargetId]);

  useEffect(() => {
    cropSessionRef.current = null;
    if (!cropTargetId || !cropTarget || cropTarget.locked || cropTarget.hidden) return;
    if (typeof window === "undefined") return;

    let active = true;
    const sourceImage = new window.Image();
    sourceImage.crossOrigin = "anonymous";
    sourceImage.decoding = "async";
    const openDecodedSession = () => {
      if (!active) return;
      if (sourceImage.naturalWidth <= 0 || sourceImage.naturalHeight <= 0) {
        setCropFailure({
          targetId: cropTarget.id,
          message: "图片尺寸无效，无法进入裁剪；请替换素材后重试",
        });
        return;
      }
      const source = {
        width: sourceImage.naturalWidth,
        height: sourceImage.naturalHeight,
      };
      const frame = { width: cropTarget.width, height: cropTarget.height };
      const entryCrop = initialCropForSession(
        cropTarget.fitMode,
        cropTarget.crop,
        source,
        frame,
      );
      const fullSourceCrop = resetCrop(cropTarget.fitMode, source, frame);
      const session = {
        targetId: cropTarget.id,
        assetId: cropTarget.assetId,
        fitMode: cropTarget.fitMode,
        source,
        frame,
        resetCrop: fullSourceCrop,
        currentCrop: entryCrop,
      };
      cropSessionRef.current = session;
      setCropSession(session);
      setCropFailure(null);
      dispatch({
        type: "PREVIEW_ELEMENT",
        id: cropTarget.id,
        patch: { crop: entryCrop },
      });
    };
    sourceImage.onload = () => {
      if (typeof sourceImage.decode !== "function") {
        openDecodedSession();
        return;
      }
      void sourceImage.decode().then(openDecodedSession, () => {
        if (active) setCropFailure({
          targetId: cropTarget.id,
          message: "图片解码失败，无法进入裁剪；请替换素材后重试",
        });
      });
    };
    sourceImage.onerror = () => {
      if (active) setCropFailure({
        targetId: cropTarget.id,
        message: "图片加载失败，无法进入裁剪；请检查素材后重试",
      });
    };
    sourceImage.src = assetUrlForId(cropTarget.assetId);
    return () => {
      active = false;
      sourceImage.onload = null;
      sourceImage.onerror = null;
      sourceImage.src = "";
    };
  }, [
    assetUrlForId,
    cropTarget,
    cropTargetId,
    dispatch,
  ]);

  const previewCrop = useCallback((next: NormalizedCrop) => {
    const current = cropSessionRef.current;
    if (!current) return;
    const session = { ...current, currentCrop: next };
    cropSessionRef.current = session;
    setCropSession(session);
    dispatch({
      type: "PREVIEW_ELEMENT",
      id: current.targetId,
      patch: { crop: next },
    });
  }, [dispatch]);

  const cancelCrop = useCallback(() => {
    dispatch({ type: "CLEAR_PREVIEW" });
    cropSessionRef.current = null;
    setCropSession(null);
    setCropFailure(null);
    onCropExit();
  }, [dispatch, onCropExit]);

  const applyCrop = useCallback(() => {
    const current = cropSessionRef.current;
    if (!current) return;
    dispatch({
      type: "COMMIT_ELEMENT",
      id: current.targetId,
      patch: { crop: current.currentCrop },
    });
    dispatch({ type: "CLEAR_PREVIEW" });
    cropSessionRef.current = null;
    setCropSession(null);
    setCropFailure(null);
    onCropExit();
  }, [dispatch, onCropExit]);

  const panCurrentCrop = useCallback((movement: { x: number; y: number }) => {
    const current = cropSessionRef.current;
    if (!current) return;
    previewCrop(panCrop(current.currentCrop, movement, {
      fitMode: current.fitMode,
      source: current.source,
      frame: current.frame,
    }));
  }, [previewCrop]);

  const zoomCurrentCrop = useCallback((factor: number) => {
    const current = cropSessionRef.current;
    if (!current) return;
    previewCrop(zoomCrop(current.currentCrop, factor));
  }, [previewCrop]);

  const resetCurrentCrop = useCallback(() => {
    const current = cropSessionRef.current;
    if (current) previewCrop(current.resetCrop);
  }, [previewCrop]);
  const commitSelectedAdjustment = (
    adjustment: (
      element: PortalElement,
    ) => Partial<Pick<PortalElement, "width" | "height" | "rotation">>,
  ) => {
    const committedElement = state.present.elements.find(
      (element) => element.id === selectedId,
    );
    if (!committedElement || committedElement.locked) return;
    const patch = adjustment(committedElement);
    const normalized = normalizeTransformedElement(
      state.present,
      committedElement,
      {
        x: committedElement.x,
        y: committedElement.y,
        width: patch.width ?? committedElement.width,
        height: patch.height ?? committedElement.height,
        rotation: patch.rotation ?? committedElement.rotation,
      },
    );
    dispatch({
      type: "COMMIT_ELEMENT",
      id: committedElement.id,
      patch: normalized,
    });
  };

  const designPointFromStage = useCallback((stage: Konva.Stage | null) => {
    if (!stage) return null;
    const pointer = stage.getPointerPosition();
    if (!pointer) return null;
    const safeZoom = Math.max(0.1, zoom);
    return {
      x: Math.min(canvasWidth, Math.max(0, pointer.x / safeZoom)),
      y: Math.min(canvasHeight, Math.max(0, pointer.y / safeZoom)),
    };
  }, [canvasHeight, canvasWidth, zoom]);

  const beginFreehandStroke = useCallback((stage: Konva.Stage | null) => {
    if (!freehandMode) return false;
    const point = designPointFromStage(stage);
    if (!point) return false;
    const next = [point];
    draftStrokeRef.current = next;
    setDraftStroke(next);
    setEditingId(null);
    setGuides([]);
    return true;
  }, [designPointFromStage, freehandMode]);

  const extendFreehandStroke = useCallback((stage: Konva.Stage | null) => {
    if (!draftStrokeRef.current) return;
    const point = designPointFromStage(stage);
    if (!point) return;
    const next = appendFreehandPoint(draftStrokeRef.current, point);
    if (next === draftStrokeRef.current) return;
    draftStrokeRef.current = next;
    setDraftStroke(next);
  }, [designPointFromStage]);

  const finishFreehandStroke = useCallback(() => {
    const points = draftStrokeRef.current;
    draftStrokeRef.current = null;
    setDraftStroke(null);
    if (!points || points.length < 2) return;
    if (state.present.elements.length >= 200) return;
    const element = buildFreehandElementFromStroke(points, {
      canvasWidth,
      canvasHeight,
      zIndex: state.present.elements.length,
      stroke: freehandStyle?.stroke ?? FREEHAND_DEFAULT_STROKE,
      strokeWidth: freehandStyle?.strokeWidth ?? FREEHAND_DEFAULT_STROKE_WIDTH,
      tension: freehandStyle?.tension ?? FREEHAND_DEFAULT_TENSION,
      opacity: freehandStyle?.opacity ?? 1,
    });
    if (!element) return;
    dispatch({ type: "ADD_ELEMENT", element });
    onFreehandComplete();
  }, [
    canvasHeight,
    canvasWidth,
    dispatch,
    freehandStyle?.opacity,
    freehandStyle?.stroke,
    freehandStyle?.strokeWidth,
    freehandStyle?.tension,
    onFreehandComplete,
    state.present.elements.length,
  ]);

  useEffect(() => {
    if (freehandMode) return;
    draftStrokeRef.current = null;
  }, [freehandMode]);

  useEffect(() => {
    if (!draftStroke) return;
    const onWindowUp = () => finishFreehandStroke();
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("touchend", onWindowUp);
    window.addEventListener("touchcancel", onWindowUp);
    return () => {
      window.removeEventListener("mouseup", onWindowUp);
      window.removeEventListener("touchend", onWindowUp);
      window.removeEventListener("touchcancel", onWindowUp);
    };
  }, [draftStroke, finishFreehandStroke]);

  const showAdjustment =
    Boolean(selected && !selected.locked && !editingElement && !cropTargetId && !freehandMode);
  const adjustmentCss = showAdjustment && selected
    ? clampAdjustmentGroupCssPosition(
      selected,
      { width: canvasWidth, height: canvasHeight },
      zoom,
    )
    : null;
  const draftStrokePoints = freehandMode
    ? draftStroke?.flatMap(({ x, y }) => [x, y]) ?? null
    : null;

  return (
    <div
      data-testid="portal-editor-stage-host"
      data-draw-tool={drawTool ?? undefined}
      className={className}
      style={{
        position: "relative",
        width: canvasWidth * zoom,
        height: canvasHeight * zoom,
        // Visible so the fixed-CSS adjustment strip is never clipped at extreme zoom-out.
        overflow: "visible",
        cursor: freehandMode ? "crosshair" : undefined,
      }}
    >
      <div
        aria-label="门户画布"
        data-testid="portal-editor-canvas-clip"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: scene.background.backgroundColor,
        }}
      >
      {/*
        CSS background plane matches published-scene (contain/cover + % position).
        Parent size is zoomed; this plane is design-sized then scale(zoom) so the map
        samples identically to the employee published plane (not Konva resample).
      */}
      <div
        aria-hidden="true"
        data-testid="portal-editor-background-plane"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: canvasHeight,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
          pointerEvents: "none",
          backgroundColor: scene.background.backgroundColor,
          backgroundImage: backgroundUrl ? `url("${backgroundUrl}")` : undefined,
          backgroundSize: scene.background.fitMode === "AUTO_HEIGHT" ? "100% auto" : scene.background.fitMode.toLowerCase(),
          backgroundPosition: scene.background.fitMode === "AUTO_HEIGHT" ? "left top" : `${scene.background.positionX}% ${scene.background.positionY}%`,
          backgroundRepeat: "no-repeat",
        }}
      />
      <Stage
        ref={setStageNode}
        width={canvasWidth * zoom}
        height={canvasHeight * zoom}
        scaleX={zoom}
        scaleY={zoom}
        style={{ position: "relative", zIndex: 1 }}
        onMouseDown={(event) => {
          const stage = event.target.getStage();
          if (freehandMode) {
            beginFreehandStroke(stage);
            return;
          }
          if (event.target !== stage) return;
          setEditingId(null);
          setGuides([]);
          dispatch({ type: "SELECT_ELEMENT", id: null, source: "CANVAS" });
        }}
        onMouseMove={(event) => {
          if (!draftStrokeRef.current) return;
          extendFreehandStroke(event.target.getStage());
        }}
        onMouseUp={() => {
          if (!draftStrokeRef.current) return;
          finishFreehandStroke();
        }}
        onTouchStart={(event) => {
          const stage = event.target.getStage();
          if (freehandMode) {
            beginFreehandStroke(stage);
            return;
          }
          if (event.target !== stage) return;
          setEditingId(null);
          setGuides([]);
          dispatch({ type: "SELECT_ELEMENT", id: null, source: "CANVAS" });
        }}
        onTouchMove={(event) => {
          if (!draftStrokeRef.current) return;
          extendFreehandStroke(event.target.getStage());
        }}
        onTouchEnd={() => {
          if (!draftStrokeRef.current) return;
          finishFreehandStroke();
        }}
      >
        <Layer name="portal-background-layer" listening={false}>
          {/* Transparent hit slab only — painted map lives on the CSS plane above. */}
          <Rect
            width={canvasWidth}
            height={canvasHeight}
            fill="rgba(0,0,0,0)"
          />
        </Layer>
        <Layer name="portal-elements-layer">
          {visibleElements.map((element) => (
            <ElementNode
              key={element.id}
              element={element}
              transformBaseline={
                state.present.elements.find((candidate) => candidate.id === element.id) ?? element
              }
              selected={!freehandMode && element.id === selectedId}
              editing={element.id === editingId}
              dispatch={dispatch}
              assetUrlForId={assetUrlForId}
              onSelect={(selectedElement, append) => {
                if (freehandMode) return;
                setEditingId(null);
                dispatch({
                  type: "SELECT_ELEMENT",
                  id: selectedElement.id,
                  source: "CANVAS",
                  ...(append ? { append: true } : {}),
                });
              }}
              onEdit={(textElement) => {
                if (freehandMode) return;
                setEditingId(textElement.id);
                dispatch({ type: "SELECT_ELEMENT", id: textElement.id, source: "CANVAS" });
              }}
              resolveDrag={(movingElement, position) =>
                snapElementPosition(
                  movingElement,
                  position,
                  visibleElements,
                  scene.viewport,
                  state.snapEnabled,
                  { canvasWidth, canvasHeight },
                )}
              resolveTransform={(transformingElement, patch) =>
                normalizeTransformedElement(state.present, transformingElement, patch)}
              onGuidesChange={setGuides}
              cropMode={element.id === cropTargetId}
              interactionLocked={cropTargetId !== null || freehandMode}
              onCropPan={panCurrentCrop}
              onCropWheel={(deltaY) => zoomCurrentCrop(deltaY < 0 ? 1.1 : 1 / 1.1)}
            />
          ))}
        </Layer>
        {draftStrokePoints && draftStrokePoints.length >= 4 && (
          <Layer name="portal-freehand-draft-layer" listening={false}>
            <Line
              name="portal-freehand-draft"
              points={draftStrokePoints}
              stroke={freehandStyle?.stroke ?? FREEHAND_DEFAULT_STROKE}
              strokeWidth={freehandStyle?.strokeWidth ?? FREEHAND_DEFAULT_STROKE_WIDTH}
              tension={freehandStyle?.tension ?? FREEHAND_DEFAULT_TENSION}
              opacity={freehandStyle?.opacity ?? 1}
              lineCap="round"
              lineJoin="round"
            />
          </Layer>
        )}
        <Layer name="portal-guides-layer" listening={false}>
          {guides.map((guide) => (
            <Line
              key={`${guide.axis}-${guide.value}`}
              points={guide.axis === "VERTICAL"
                ? [guide.value, 0, guide.value, canvasHeight]
                : [0, guide.value, canvasWidth, guide.value]}
              stroke="#2563EB"
              strokeWidth={1 / zoom}
              dash={[6 / zoom, 4 / zoom]}
            />
          ))}
        </Layer>
      </Stage>

      <div
        aria-label="画布键盘操作层"
        data-testid="portal-design-plane"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: canvasHeight,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
          pointerEvents: "none",
        }}
      >
        {visibleElements.map((element) => (
          <button
            key={element.id}
            type="button"
            aria-label={elementLabel(element)}
            aria-keyshortcuts={element.type === "TEXT" && !element.locked ? "Enter F2" : "Enter"}
            data-portal-element-type={element.type}
            data-portal-element-id={element.id}
            onFocus={() => setKeyboardFocusId(element.id)}
            onBlur={() => setKeyboardFocusId((current) => current === element.id ? null : current)}
            onClick={() => {
              setEditingId(null);
              dispatch({ type: "SELECT_ELEMENT", id: element.id, source: "CANVAS" });
            }}
            onDoubleClick={() => {
              if (element.type !== "TEXT" || element.locked) return;
              setEditingId(element.id);
              dispatch({ type: "SELECT_ELEMENT", id: element.id, source: "CANVAS" });
            }}
            onKeyDown={(event) => {
              if (
                (event.key === "Enter" || event.key === "F2")
                && element.type === "TEXT"
                && !element.locked
              ) {
                event.preventDefault();
                setEditingId(element.id);
                dispatch({ type: "SELECT_ELEMENT", id: element.id, source: "CANVAS" });
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setEditingId(null);
                dispatch({ type: "SELECT_ELEMENT", id: element.id, source: "CANVAS" });
              }
            }}
            style={{
              position: "absolute",
              left: element.x,
              top: element.y,
              width: element.width,
              height: element.height,
              boxSizing: "border-box",
              margin: 0,
              padding: 0,
              border: 0,
              // Parent plane scale(zoom): use design units so outline stays ~2 CSS px at any zoom.
              outline: keyboardFocusId === element.id ? `${2 / zoom}px solid #2563EB` : "none",
              outlineOffset: 2 / zoom,
              background: keyboardFocusId === element.id
                ? "rgba(37, 99, 235, 0.08)"
                : "transparent",
              color: "transparent",
              transform: `rotate(${element.rotation}deg)`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
          />
        ))}
        {selected && !selected.locked && !editingElement && !cropTargetId && (
          <span
            aria-label="选中元素控制框"
            data-portal-element-id={selected.id}
            data-resize-anchors="top-left,top-center,top-right,middle-left,middle-right,bottom-left,bottom-center,bottom-right"
            data-rotation-enabled="true"
            style={{
              position: "absolute",
              left: selected.x,
              top: selected.y,
              width: selected.width,
              height: selected.height,
              boxSizing: "border-box",
              border: `${1 / zoom}px dashed #2563EB`,
              transform: `rotate(${selected.rotation}deg)`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
          />
        )}
        {guides.map((guide) => (
          <span
            key={`${guide.axis}-${guide.value}`}
            aria-label="对齐参考线"
            data-snap-axis={guide.axis}
            data-snap-value={guide.value}
          />
        ))}
      </div>
      </div>

      {showAdjustment && adjustmentCss && (
        <div
          role="group"
          aria-label="选中元素精确调整"
          data-testid="portal-adjustment-overlay"
          style={{
            position: "absolute",
            left: adjustmentCss.left,
            top: adjustmentCss.top,
            zIndex: 20,
            display: "flex",
            gap: ADJUSTMENT_CHROME.gap,
            padding: ADJUSTMENT_CHROME.padding,
            border: `${ADJUSTMENT_CHROME.border}px solid #93C5FD`,
            borderRadius: ADJUSTMENT_CHROME.radius,
            background: "#FFFFFF",
            boxShadow: "0 2px 8px rgba(15, 23, 42, 0.18)",
            pointerEvents: "auto",
            width: adjustmentCss.width,
            height: adjustmentCss.height,
            boxSizing: "border-box",
          }}
        >
          {GEOMETRY_ADJUSTMENTS.map((adjustment) => (
            <button
              key={adjustment.id}
              type="button"
              aria-label={adjustment.label}
              aria-keyshortcuts="Enter Space"
              onFocus={() => setAdjustmentFocusId(adjustment.id)}
              onBlur={() => setAdjustmentFocusId((current) =>
                current === adjustment.id ? null : current)}
              onClick={() => commitSelectedAdjustment(adjustment.patch)}
              style={{
                width: ADJUSTMENT_CHROME.buttonSize,
                height: ADJUSTMENT_CHROME.buttonSize,
                flex: "0 0 auto",
                margin: 0,
                padding: 0,
                border: "1px solid #2563EB",
                borderRadius: 4,
                outline: adjustmentFocusId === adjustment.id
                  ? "2px solid #0F172A"
                  : "1px solid transparent",
                outlineOffset: 2,
                background: "#EFF6FF",
                color: "#1E3A8A",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              {adjustment.text}
            </button>
          ))}
        </div>
      )}

      {cropMessage && (
        <div
          role={cropMessage.includes("失败") || cropMessage.includes("无法") ? "alert" : "status"}
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 5,
            margin: 0,
            padding: "8px 12px",
            borderRadius: 6,
            background: "#FFFFFF",
            color: "#991B1B",
            boxShadow: "0 2px 8px rgba(15, 23, 42, 0.2)",
          }}
        >
          <span>{cropMessage}</span>
          <button
            type="button"
            onClick={cancelCrop}
            style={{ marginLeft: 8 }}
          >
            退出裁剪
          </button>
        </div>
      )}

      {activeCropSession && (
        <div
          role="toolbar"
          aria-label="图片裁剪工具"
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: 8,
            border: "1px solid #93C5FD",
            borderRadius: 8,
            background: "#FFFFFF",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.22)",
          }}
        >
          <div
            ref={cropKeyboardRef}
            role="group"
            aria-label="图片裁剪键盘控制"
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - Home Enter Escape"
            tabIndex={0}
            onKeyDown={(event) => {
              const distance = event.shiftKey ? 10 : 1;
              switch (event.key) {
                case "ArrowLeft":
                  panCurrentCrop({ x: -distance, y: 0 });
                  break;
                case "ArrowRight":
                  panCurrentCrop({ x: distance, y: 0 });
                  break;
                case "ArrowUp":
                  panCurrentCrop({ x: 0, y: -distance });
                  break;
                case "ArrowDown":
                  panCurrentCrop({ x: 0, y: distance });
                  break;
                case "+":
                case "=":
                  zoomCurrentCrop(1.1);
                  break;
                case "-":
                  zoomCurrentCrop(1 / 1.1);
                  break;
                case "Home":
                  resetCurrentCrop();
                  break;
                case "Enter":
                  applyCrop();
                  break;
                case "Escape":
                  cancelCrop();
                  break;
                default:
                  if (event.key !== "Delete" && event.key !== "Backspace") return;
              }
              event.preventDefault();
              event.stopPropagation();
            }}
            style={{
              padding: "4px 8px",
              borderRadius: 4,
              outline: "2px solid #2563EB",
              outlineOffset: 2,
            }}
          >
            方向键移动（Shift ×10），+/- 缩放，Home 重置
          </div>
          <button type="button" aria-label="裁剪放大" onClick={() => zoomCurrentCrop(1.1)}>＋</button>
          <button type="button" aria-label="裁剪缩小" onClick={() => zoomCurrentCrop(1 / 1.1)}>−</button>
          <button type="button" aria-label="重置裁剪" onClick={resetCurrentCrop}>重置</button>
          <button type="button" aria-label="取消裁剪" onClick={cancelCrop}>取消</button>
          <button type="button" aria-label="应用裁剪" onClick={applyCrop}>应用</button>
        </div>
      )}

      {editingElement && stageNode && (
        <TextOverlay
          element={editingElement}
          stage={stageNode}
          zoom={zoom}
          onCommit={(text) => {
            setEditingId(null);
            dispatch({ type: "COMMIT_ELEMENT", id: editingElement.id, patch: { text } });
          }}
          onCancel={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

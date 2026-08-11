"use client";

import type Konva from "konva";
import type { IconNode } from "lucide-react";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Arrow,
  Circle as KonvaCircle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Line,
  Path,
  Rect,
  Text,
  Transformer,
} from "react-konva";

import {
  arrowGeometry,
  effectiveCornerRadius,
  imageRenderGeometry,
  portalDashPattern,
} from "@/features/portal/portal-geometry";
import type { EditorAction, ElementPatch } from "@/features/portal/editor/editor-types";
import type { PortalElement } from "@/features/portal/portal-scene";
import { closedShapeFillStyle } from "@/features/portal/portal-shape-fill";

export type SnapGuide = {
  axis: "HORIZONTAL" | "VERTICAL";
  value: number;
};

export type ResolvedDrag = {
  patch: Pick<PortalElement, "x" | "y">;
  guides: SnapGuide[];
};

type TransformSnapshot = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};

export type ElementNodeProps = {
  element: PortalElement;
  transformBaseline: PortalElement;
  selected: boolean;
  editing: boolean;
  dispatch: (action: EditorAction) => void;
  onSelect(element: PortalElement, append: boolean): void;
  onEdit(element: Extract<PortalElement, { type: "TEXT" }>): void;
  resolveDrag(element: PortalElement, position: { x: number; y: number }): ResolvedDrag;
  resolveTransform(
    element: PortalElement,
    patch: Pick<PortalElement, "x" | "y" | "width" | "height" | "rotation">,
  ): PortalElement;
  onGuidesChange(guides: SnapGuide[]): void;
  assetUrlForId?(assetId: string): string;
  cropMode?: boolean;
  interactionLocked?: boolean;
  onCropPan?(movement: { x: number; y: number }): void;
  onCropWheel?(deltaY: number): void;
};

const RESIZE_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

type IconElement = Extract<PortalElement, { type: "ICON" }>;
type IconVisual = Pick<IconElement, "id" | "iconName" | "color" | "width" | "height">;

const LUCIDE_ICON_IMPORT_KEYS = {
  ArrowRight: "arrow-right",
  BookOpen: "book-open",
  BriefcaseBusiness: "briefcase-business",
  Building2: "building-2",
  Bus: "bus",
  Car: "car",
  CheckCircle2: "check-circle-2",
  Clock: "clock",
  Coffee: "coffee",
  Heart: "heart",
  Home: "home",
  Hotel: "hotel",
  Info: "info",
  Landmark: "landmark",
  Mail: "mail",
  MapPin: "map-pin",
  Navigation: "navigation",
  Phone: "phone",
  ShieldCheck: "shield-check",
  Star: "star",
  Train: "train",
  Users: "users",
  Utensils: "utensils",
  Wifi: "wifi",
} as const satisfies Record<IconElement["iconName"], keyof typeof dynamicIconImports>;

function numericAttribute(attributes: Record<string, string>, name: string) {
  return Number(attributes[name] ?? 0);
}

function pointAttribute(value: string | undefined) {
  return (value?.trim().split(/[\s,]+/u) ?? []).map(Number);
}

function LucideIconShape({ element }: { element: IconVisual }) {
  const [loadedIcon, setLoadedIcon] = useState<{
    iconName: IconElement["iconName"];
    iconNode: IconNode;
  } | null>(null);
  const size = Math.min(element.width, element.height);
  const common = {
    stroke: element.color,
    strokeWidth: 2,
    lineCap: "round" as const,
    lineJoin: "round" as const,
  };

  useEffect(() => {
    let current = true;
    void dynamicIconImports[LUCIDE_ICON_IMPORT_KEYS[element.iconName]]().then(
      (iconModule) => {
        if (current) {
          setLoadedIcon({
            iconName: element.iconName,
            iconNode: iconModule.__iconNode,
          });
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [element.iconName]);
  const iconNode = loadedIcon?.iconName === element.iconName ? loadedIcon.iconNode : null;

  return (
    <>
      <Rect
        name={`portal-icon-bounds-${element.id}`}
        x={0}
        y={0}
        width={element.width}
        height={element.height}
        fill="rgba(0, 0, 0, 0)"
        listening={false}
      />
      <Group
        name={`portal-shape-${element.id}`}
        x={(element.width - size) / 2}
        y={(element.height - size) / 2}
        scaleX={size / 24}
        scaleY={size / 24}
      >
        {iconNode?.map(([kind, attributes], index) => {
          const name = `portal-icon-${element.id}-${index}`;
          switch (kind) {
            case "path":
              return (
                <Path
                  key={attributes.key ?? `${kind}-${index}`}
                  name={name}
                  data={attributes.d}
                  {...common}
                />
              );
            case "circle":
              return (
                <KonvaCircle
                  key={attributes.key ?? `${kind}-${index}`}
                  name={name}
                  x={numericAttribute(attributes, "cx")}
                  y={numericAttribute(attributes, "cy")}
                  radius={numericAttribute(attributes, "r")}
                  {...common}
                />
              );
            case "rect":
              return (
                <Rect
                  key={attributes.key ?? `${kind}-${index}`}
                  name={name}
                  x={numericAttribute(attributes, "x")}
                  y={numericAttribute(attributes, "y")}
                  width={numericAttribute(attributes, "width")}
                  height={numericAttribute(attributes, "height")}
                  cornerRadius={numericAttribute(attributes, "rx")}
                  {...common}
                />
              );
            case "polygon":
              return (
                <Line
                  key={attributes.key ?? `${kind}-${index}`}
                  name={name}
                  points={pointAttribute(attributes.points)}
                  closed
                  {...common}
                />
              );
            default:
              return null;
          }
        })}
      </Group>
    </>
  );
}

function shadowProps(
  shadow: Extract<PortalElement, { type: "RECT" }>["shadow"],
) {
  return shadow === null ? {} : {
    shadowColor: shadow.color,
    shadowOpacity: shadow.opacity,
    shadowBlur: shadow.blur,
    shadowOffsetX: shadow.offsetX,
    shadowOffsetY: shadow.offsetY,
  };
}

export function PortalAssetImageLoader({
  src,
  children,
}: {
  src: string;
  children: (image: HTMLImageElement | null) => ReactNode;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let active = true;
    const nextImage = new window.Image();
    nextImage.crossOrigin = "anonymous";
    nextImage.decoding = "async";
    nextImage.onload = () => {
      if (active) setImage(nextImage);
    };
    nextImage.onerror = () => {
      if (active) setImage(null);
    };
    nextImage.src = src;
    return () => {
      active = false;
      nextImage.onload = null;
      nextImage.onerror = null;
      nextImage.src = "";
    };
  }, [src]);

  return children(image);
}

export function normalizeNodeTransform(
  element: PortalElement,
  transform: TransformSnapshot,
): Pick<PortalElement, "x" | "y" | "width" | "height" | "rotation"> {
  const width = Math.max(1, element.width * Math.abs(transform.scaleX));
  const height = Math.max(1, element.height * Math.abs(transform.scaleY));
  return {
    x: transform.x - width / 2,
    y: transform.y - height / 2,
    width,
    height,
    rotation: transform.rotation,
  };
}

function ElementShape({
  element,
  assetUrlForId,
}: {
  element: PortalElement;
  assetUrlForId: (assetId: string) => string;
}) {
  const imageSource = element.type === "IMAGE" ? assetUrlForId(element.assetId) : null;
  const lineGeometry = useMemo(
    () => element.type === "LINE" || element.type === "ARROW" ? arrowGeometry(element) : null,
    [element],
  );

  switch (element.type) {
    case "TEXT":
      return (
        <>
          {element.backgroundColor !== null && (
            <Rect
              name={`portal-text-background-${element.id}`}
              width={element.width}
              height={element.height}
              fill={element.backgroundColor}
            />
          )}
          <Text
            name={`portal-shape-${element.id}`}
            text={element.text}
            width={element.width}
            height={element.height}
            fill={element.color}
            fontFamily={element.fontFamily}
            fontSize={element.fontSize}
            fontStyle={element.italic
              ? `italic ${element.fontWeight}`
              : String(element.fontWeight)}
            textDecoration={element.underline ? "underline" : ""}
            letterSpacing={element.letterSpacing}
            lineHeight={element.lineHeight}
            align={element.align.toLowerCase()}
            verticalAlign="top"
            wrap="word"
          />
        </>
      );
    case "RECT": {
      const fillStyle = closedShapeFillStyle({ ...element, forHitTesting: true });
      return (
        <Rect
          name={`portal-shape-${element.id}`}
          width={element.width}
          height={element.height}
          fill={fillStyle.fill}
          fillEnabled={fillStyle.fillEnabled}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke === null ? 0 : element.strokeWidth}
          hitStrokeWidth={element.fillEnabled ? undefined : Math.max(20, element.strokeWidth || 0)}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
        />
      );
    }
    case "CIRCLE": {
      const fillStyle = closedShapeFillStyle({ ...element, forHitTesting: true });
      return (
        <Ellipse
          name={`portal-shape-${element.id}`}
          x={element.width / 2}
          y={element.height / 2}
          radiusX={element.width / 2}
          radiusY={element.height / 2}
          fill={fillStyle.fill}
          fillEnabled={fillStyle.fillEnabled}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke === null ? 0 : element.strokeWidth}
          hitStrokeWidth={element.fillEnabled ? undefined : Math.max(20, element.strokeWidth || 0)}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
        />
      );
    }
    case "ELLIPSE": {
      const fillStyle = closedShapeFillStyle({ ...element, forHitTesting: true });
      return (
        <Ellipse
          name={`portal-shape-${element.id}`}
          x={element.width / 2}
          y={element.height / 2}
          radiusX={element.width / 2}
          radiusY={element.height / 2}
          fill={fillStyle.fill}
          fillEnabled={fillStyle.fillEnabled}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke === null ? 0 : element.strokeWidth}
          hitStrokeWidth={element.fillEnabled ? undefined : Math.max(20, element.strokeWidth || 0)}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
        />
      );
    }
    case "ROUND_RECT": {
      const fillStyle = closedShapeFillStyle({ ...element, forHitTesting: true });
      return (
        <Rect
          name={`portal-shape-${element.id}`}
          width={element.width}
          height={element.height}
          cornerRadius={effectiveCornerRadius(element)}
          fill={fillStyle.fill}
          fillEnabled={fillStyle.fillEnabled}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke === null ? 0 : element.strokeWidth}
          hitStrokeWidth={element.fillEnabled ? undefined : Math.max(20, element.strokeWidth || 0)}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
        />
      );
    }
    case "TRIANGLE": {
      const fillStyle = closedShapeFillStyle({ ...element, forHitTesting: true });
      return (
        <Line
          name={`portal-shape-${element.id}`}
          points={[element.width / 2, 0, element.width, element.height, 0, element.height]}
          closed
          lineJoin="round"
          fill={fillStyle.fill}
          fillEnabled={fillStyle.fillEnabled}
          stroke={element.stroke ?? undefined}
          strokeWidth={element.stroke === null ? 0 : element.strokeWidth}
          hitStrokeWidth={element.fillEnabled ? undefined : Math.max(20, element.strokeWidth || 0)}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
        />
      );
    }
    case "LINE":
      return (
        <Line
          name={`portal-shape-${element.id}`}
          points={lineGeometry!.points}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
          lineCap="round"
          lineJoin="round"
        />
      );
    case "ARROW":
      return (
        <Arrow
          name={`portal-shape-${element.id}`}
          points={lineGeometry!.points}
          stroke={element.stroke}
          fill={element.stroke}
          strokeWidth={element.strokeWidth}
          dash={portalDashPattern(element.dash, element.strokeWidth)}
          {...shadowProps(element.shadow)}
          pointerLength={lineGeometry!.pointerLength}
          pointerWidth={lineGeometry!.pointerWidth}
          lineCap="round"
          lineJoin="round"
        />
      );
    case "FREEHAND":
      return (
        <Line
          name={`portal-shape-${element.id}`}
          points={element.points}
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          tension={element.tension}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(20, element.strokeWidth)}
        />
      );
    case "IMAGE": {
      return (
        <PortalAssetImageLoader key={imageSource} src={imageSource!}>
          {(image) => {
            if (!image) {
              return (
                <Rect
                  name={`portal-shape-${element.id}`}
                  width={element.width}
                  height={element.height}
                  fill="#E5E7EB"
                  cornerRadius={effectiveCornerRadius(element)}
                />
              );
            }
            return (
              <Group
                name={`portal-image-clip-${element.id}`}
                clipFunc={(context) => {
                  const radius = effectiveCornerRadius(element);
                  context.beginPath();
                  context.roundRect(0, 0, element.width, element.height, radius);
                  context.closePath();
                }}
              >
                <Rect
                  width={element.width}
                  height={element.height}
                  fill="#E5E7EB"
                  cornerRadius={effectiveCornerRadius(element)}
                />
                <KonvaImage
                  name={`portal-shape-${element.id}`}
                  image={image}
                  {...imageRenderGeometry(element, image)}
                />
              </Group>
            );
          }}
        </PortalAssetImageLoader>
      );
    }
    case "ICON":
      return <LucideIconShape element={element} />;
    case "BUTTON":
      return (
        <>
          <Rect
            name={`portal-shape-${element.id}`}
            width={element.width}
            height={element.height}
            fill={element.backgroundColor}
            cornerRadius={effectiveCornerRadius(element)}
            stroke={element.border?.color}
            strokeWidth={element.border?.width ?? 0}
            dash={element.border
              ? portalDashPattern(element.border.dash, element.border.width)
              : []}
            {...shadowProps(element.shadow)}
          />
          <Text
            text={element.text}
            width={element.width}
            height={element.height}
            fill={element.color}
            fontFamily={element.fontFamily}
            fontSize={element.fontSize}
            fontStyle={String(element.fontWeight)}
            lineHeight={element.lineHeight}
            align={element.align.toLowerCase()}
            verticalAlign="middle"
            wrap="word"
          />
        </>
      );
    case "MARKER": {
      const iconSize = Math.min(element.height * 0.65, element.width * 0.28);
      return (
        <>
          <Ellipse
            name={`portal-shape-${element.id}`}
            x={element.width / 2}
            y={element.height / 2}
            radiusX={element.width / 2}
            radiusY={element.height / 2}
            fill={element.backgroundColor}
          />
          <Group x={8} y={(element.height - iconSize) / 2}>
            <LucideIconShape element={{
              id: element.id,
              iconName: element.iconName,
              color: element.color,
              width: iconSize,
              height: iconSize,
            }} />
          </Group>
          <Text
            text={element.text}
            x={iconSize + 12}
            width={Math.max(1, element.width - iconSize - 16)}
            height={element.height}
            fill={element.color}
            fontFamily="Noto Sans SC Variable"
            fontSize={Math.max(6, Math.min(20, element.height * 0.36))}
            fontStyle="bold"
            align="center"
            verticalAlign="middle"
          />
        </>
      );
    }
  }
}

export function ElementNode({
  element,
  transformBaseline,
  selected,
  editing,
  dispatch,
  onSelect,
  onEdit,
  resolveDrag,
  resolveTransform,
  onGuidesChange,
  assetUrlForId = (assetId) => `/api/files/${encodeURIComponent(assetId)}`,
  cropMode = false,
  interactionLocked = false,
  onCropPan,
  onCropWheel,
}: ElementNodeProps) {
  const nodeRef = useRef<Konva.Group>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const transformBaselineRef = useRef<PortalElement | null>(null);
  const cropDragPositionRef = useRef({ x: 0, y: 0 });
  const [activeTransformBaseline, setActiveTransformBaseline] =
    useState<PortalElement | null>(null);

  useEffect(() => {
    if (
      !selected
      || element.locked
      || cropMode
      || interactionLocked
      || !nodeRef.current
      || !transformerRef.current
    ) return;
    transformerRef.current.nodes([nodeRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
  }, [cropMode, element.locked, interactionLocked, selected]);

  const pointerPatch = (node: Konva.Node) => ({
    x: node.x() - element.width / 2,
    y: node.y() - element.height / 2,
  });

  const transformedElement = (node: Konva.Node) => {
    const baseline = transformBaselineRef.current ?? transformBaseline;
    const patch = normalizeNodeTransform(baseline, {
      x: node.x(),
      y: node.y(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
      rotation: node.rotation(),
    });
    return resolveTransform(baseline, patch);
  };

  const previewTransform = (node: Konva.Node) => {
    const resolved = transformedElement(node);
    const baseline = transformBaselineRef.current ?? transformBaseline;
    node.x(resolved.x + resolved.width / 2);
    node.y(resolved.y + resolved.height / 2);
    node.scaleX(resolved.width / baseline.width);
    node.scaleY(resolved.height / baseline.height);
    node.rotation(resolved.rotation);
    dispatch({ type: "PREVIEW_ELEMENT", id: resolved.id, patch: resolved });
  };

  const commitTransform = (node: Konva.Node) => {
    const resolved = transformedElement(node);
    node.scaleX(1);
    node.scaleY(1);
    node.x(resolved.x + resolved.width / 2);
    node.y(resolved.y + resolved.height / 2);
    node.rotation(resolved.rotation);
    transformBaselineRef.current = null;
    setActiveTransformBaseline(null);
    dispatch({ type: "COMMIT_ELEMENT", id: resolved.id, patch: resolved });
    dispatch({ type: "CLEAR_PREVIEW" });
  };

  const renderedElement = activeTransformBaseline ?? element;

  return (
    <>
      <Group
        ref={nodeRef}
        name={`portal-element-${element.id}`}
        x={renderedElement.x + renderedElement.width / 2}
        y={renderedElement.y + renderedElement.height / 2}
        width={renderedElement.width}
        height={renderedElement.height}
        offsetX={renderedElement.width / 2}
        offsetY={renderedElement.height / 2}
        rotation={renderedElement.rotation}
        opacity={renderedElement.opacity}
        visible={!editing}
        listening={!interactionLocked || cropMode}
        draggable={!element.locked && !interactionLocked}
        onClick={(event) => onSelect(element, Boolean(event.evt.shiftKey))}
        onTap={() => onSelect(element, false)}
        onDblClick={() => {
          if (element.type === "TEXT" && !element.locked) onEdit(element);
        }}
        onDblTap={() => {
          if (element.type === "TEXT" && !element.locked) onEdit(element);
        }}
        onDragMove={element.locked || interactionLocked ? undefined : (event) => {
          const resolved = resolveDrag(element, pointerPatch(event.target));
          event.target.x(resolved.patch.x + element.width / 2);
          event.target.y(resolved.patch.y + element.height / 2);
          onGuidesChange(resolved.guides);
          dispatch({ type: "PREVIEW_ELEMENT", id: element.id, patch: resolved.patch as ElementPatch });
        }}
        onDragEnd={element.locked || interactionLocked ? undefined : (event) => {
          const resolved = resolveDrag(element, pointerPatch(event.target));
          event.target.x(resolved.patch.x + element.width / 2);
          event.target.y(resolved.patch.y + element.height / 2);
          onGuidesChange([]);
          dispatch({ type: "COMMIT_ELEMENT", id: element.id, patch: resolved.patch as ElementPatch });
          dispatch({ type: "CLEAR_PREVIEW" });
        }}
        onTransformStart={element.locked || interactionLocked ? undefined : () => {
          transformBaselineRef.current = transformBaseline;
          setActiveTransformBaseline(transformBaseline);
        }}
        onTransform={element.locked || interactionLocked ? undefined : (event) => previewTransform(event.target)}
        onTransformEnd={element.locked || interactionLocked ? undefined : (event) => commitTransform(event.target)}
      >
        <ElementShape element={renderedElement} assetUrlForId={assetUrlForId} />
        {cropMode && element.type === "IMAGE" && (
          <>
            <Rect
              name={`portal-image-crop-frame-${element.id}`}
              width={element.width}
              height={element.height}
              fill="rgba(37, 99, 235, 0.08)"
              stroke="#2563EB"
              strokeWidth={2}
              dash={[8, 4]}
              listening={false}
            />
            <Rect
              name={`portal-image-crop-overlay-${element.id}`}
              width={element.width}
              height={element.height}
              fill="rgba(0, 0, 0, 0.001)"
              draggable
              onDragStart={(event) => {
                cropDragPositionRef.current = {
                  x: event.target.x(),
                  y: event.target.y(),
                };
              }}
              onDragMove={(event) => {
                const position = { x: event.target.x(), y: event.target.y() };
                const movement = {
                  x: position.x - cropDragPositionRef.current.x,
                  y: position.y - cropDragPositionRef.current.y,
                };
                cropDragPositionRef.current = position;
                onCropPan?.(movement);
              }}
              onDragEnd={(event) => {
                event.target.x(0);
                event.target.y(0);
                cropDragPositionRef.current = { x: 0, y: 0 };
              }}
              onWheel={(event) => {
                if (event.evt.ctrlKey || event.evt.metaKey) return;
                event.evt.preventDefault();
                onCropWheel?.(event.evt.deltaY);
              }}
            />
          </>
        )}
      </Group>
      {selected && !element.locked && !editing && !interactionLocked && (
        <Transformer
          ref={transformerRef}
          name="portal-selection-transformer"
          enabledAnchors={[...RESIZE_ANCHORS]}
          keepRatio={element.type === "IMAGE" && element.lockAspectRatio !== false}
          rotateEnabled
          flipEnabled={false}
        />
      )}
    </>
  );
}

"use client";

import {
  ArrowRight,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Bus,
  Car,
  CheckCircle2,
  Clock,
  Coffee,
  Heart,
  Home,
  Hotel,
  Info,
  Landmark,
  Mail,
  MapPin,
  Navigation,
  Phone,
  ShieldCheck,
  Star,
  Train,
  Users,
  Utensils,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import styles from "@/features/portal/components/published-scene.module.css";
import { freehandSvgPath } from "@/features/portal/editor/freehand-drawing";
import {
  effectiveCornerRadius,
  imageRenderGeometry,
  portalSceneCanvasSize,
  portalDashPattern,
  publishedScale,
} from "@/features/portal/portal-geometry";
import {
  portalSceneV1Schema,
  type PortalDashStyle,
  type PortalElement,
  type PortalImageElement,
  type PortalShadow,
} from "@/features/portal/portal-scene";
import type { SafePortalAction } from "@/features/portal/portal-actions";

const ICONS = {
  ArrowRight,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Bus,
  Car,
  CheckCircle2,
  Clock,
  Coffee,
  Heart,
  Home,
  Hotel,
  Info,
  Landmark,
  Mail,
  MapPin,
  Navigation,
  Phone,
  ShieldCheck,
  Star,
  Train,
  Users,
  Utensils,
  Wifi,
} as const satisfies Record<string, LucideIcon>;

function privateAssetUrl(assetId: string) {
  return `/api/files/${encodeURIComponent(assetId)}`;
}

function rgba(color: string, opacity: number) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function dropShadow(shadow: PortalShadow | null) {
  if (shadow === null || shadow.opacity === 0) return undefined;
  return `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${rgba(
    shadow.color,
    shadow.opacity,
  )})`;
}

function svgDashArray(dash: PortalDashStyle, width: number) {
  const pattern = portalDashPattern(dash, width);
  return pattern.length > 0 ? pattern.join(" ") : undefined;
}

function actionAttributes(action: SafePortalAction) {
  return action.target === "_blank"
    ? { target: "_blank" as const, rel: "noopener noreferrer" }
    : { target: "_self" as const };
}

function clampedHitBox({
  x,
  y,
  width,
  height,
  rotation,
  hitSize,
  canvasWidth,
  canvasHeight,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  hitSize: number;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const hitWidth = Math.min(canvasWidth, Math.max(width, hitSize));
  const hitHeight = Math.min(canvasHeight, Math.max(height, hitSize));
  const left = (width - hitWidth) / 2;
  const top = (height - hitHeight) / 2;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  const corners = [
    [left, top],
    [left + hitWidth, top],
    [left + hitWidth, top + hitHeight],
    [left, top + hitHeight],
  ].map(([cornerX, cornerY]) => ({
    x: x + centerX + (cornerX! - centerX) * cosine -
      (cornerY! - centerY) * sine,
    y: y + centerY + (cornerX! - centerX) * sine +
      (cornerY! - centerY) * cosine,
  }));
  const minimumX = Math.min(...corners.map((corner) => corner.x));
  const maximumX = Math.max(...corners.map((corner) => corner.x));
  const minimumY = Math.min(...corners.map((corner) => corner.y));
  const maximumY = Math.max(...corners.map((corner) => corner.y));
  const globalX = minimumX < 0
    ? -minimumX
    : maximumX > canvasWidth
      ? canvasWidth - maximumX
      : 0;
  const globalY = minimumY < 0
    ? -minimumY
    : maximumY > canvasHeight
      ? canvasHeight - maximumY
      : 0;
  return {
    left: left + globalX * cosine + globalY * sine,
    top: top - globalX * sine + globalY * cosine,
    width: hitWidth,
    height: hitHeight,
  };
}

function ActionSurface({
  action,
  elementId,
  label,
  hitSize,
  x,
  y,
  rotation,
  canvasWidth,
  canvasHeight,
  visualWidth,
  visualHeight,
  className,
  style,
  children,
}: {
  action: SafePortalAction;
  elementId: string;
  label?: string;
  hitSize: number;
  x: number;
  y: number;
  rotation: number;
  canvasWidth: number;
  canvasHeight: number;
  visualWidth: number;
  visualHeight: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const hitBox = clampedHitBox({
    x,
    y,
    width: visualWidth,
    height: visualHeight,
    rotation,
    hitSize,
    canvasWidth,
    canvasHeight,
  });
  return (
    <a
      href={action.href}
      {...actionAttributes(action)}
      aria-label={label}
      className={`${styles.interactive} ${className ?? ""}`}
      data-portal-element-id={elementId}
      style={{ ...style, position: "relative", width: "100%", height: "100%" }}
    >
      {children}
      <span
        aria-hidden="true"
        className={styles.hitSlop}
        data-portal-hit-slop=""
        style={hitBox}
      />
    </a>
  );
}

function IconVisual({
  iconName,
  color,
}: {
  iconName: keyof typeof ICONS;
  color: string;
}) {
  const Icon = ICONS[iconName];
  return (
    <span
      className={styles.icon}
      data-portal-visual-box=""
      aria-hidden="true"
      style={{ width: "100%", height: "100%" }}
    >
      <Icon color={color} />
    </span>
  );
}

function ImageVisual({ element }: { element: PortalImageElement }) {
  const [sourceSize, setSourceSize] = useState<{
    naturalWidth: number;
    naturalHeight: number;
  } | null>(null);
  const geometry = sourceSize === null
    ? null
    : imageRenderGeometry(element, sourceSize);
  const imageStyle = useMemo(() => {
    if (geometry === null || sourceSize === null) return undefined;
    const scaleX = geometry.width / geometry.crop.width;
    const scaleY = geometry.height / geometry.crop.height;
    return {
      left: geometry.x - geometry.crop.x * scaleX,
      top: geometry.y - geometry.crop.y * scaleY,
      width: sourceSize.naturalWidth * scaleX,
      height: sourceSize.naturalHeight * scaleY,
    };
  }, [geometry, sourceSize]);

  return (
    <span
      className={styles.imageFrame}
      data-portal-visual-box=""
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        borderRadius: effectiveCornerRadius(element),
      }}
    >
      {/* Private files are authenticated same-origin responses, not public Next Image assets. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={privateAssetUrl(element.assetId)}
        alt={element.altText}
        style={imageStyle}
        onLoad={(event) => {
          setSourceSize({
            naturalWidth: event.currentTarget.naturalWidth,
            naturalHeight: event.currentTarget.naturalHeight,
          });
        }}
      />
    </span>
  );
}

function dashContract(dash: PortalDashStyle, width: number) {
  const [length = 0, gap = 0] = portalDashPattern(dash, width);
  return {
    length,
    gap,
    serialized: length === 0 ? "SOLID" : `${length} ${gap}`,
  };
}

function CenteredStroke({
  color,
  width,
  radius,
}: {
  color: string;
  width: number;
  radius: number | "50%";
}) {
  return (
    <span
      aria-hidden="true"
      className={styles.shapeStroke}
      data-portal-stroke=""
      style={{
        left: -width / 2,
        top: -width / 2,
        width: `calc(100% + ${width}px)`,
        height: `calc(100% + ${width}px)`,
        borderRadius: radius === "50%" ? "50%" : radius + width / 2,
        border: `${width}px solid ${color}`,
      }}
    />
  );
}

type StrokePathKind =
  | "RECT"
  | "CIRCLE"
  | "ELLIPSE"
  | "ROUND_RECT"
  | "TRIANGLE";

type StrokePoint = { x: number; y: number; edge: number };
type StrokePiece = {
  start: StrokePoint;
  end: StrokePoint;
  group: number;
  pathStart: number;
  pathEnd: number;
};

const MAX_STROKE_PIECES = 256;
const MAX_CLIP_PATH_CHARS = 24_000;

function curveSteps(radius: number, arc = Math.PI * 2) {
  if (radius <= 1) return 1;
  const maxAngle = 2 * Math.acos(Math.max(-1, 1 - 1 / radius));
  return Math.max(1, Math.ceil(arc / maxAngle));
}

function ellipsePath(width: number, height: number): StrokePoint[] {
  const steps = curveSteps(Math.max(width, height) / 2);
  return Array.from({ length: steps }, (_, index) => {
    const angle = index * Math.PI * 2 / steps;
    return {
      x: width / 2 + Math.cos(angle) * width / 2,
      y: height / 2 + Math.sin(angle) * height / 2,
      edge: index,
    };
  });
}

function roundedRectPath(
  width: number,
  height: number,
  radius: number,
): StrokePoint[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return [
      { x: 0, y: 0, edge: 0 },
      { x: width, y: 0, edge: 1 },
      { x: width, y: height, edge: 2 },
      { x: 0, y: height, edge: 3 },
    ];
  }
  const points: StrokePoint[] = [{ x: r, y: 0, edge: 0 }];
  let edge = 0;
  const lineTo = (x: number, y: number) => {
    edge += 1;
    points.push({ x, y, edge });
  };
  const arcTo = (
    centerX: number,
    centerY: number,
    startAngle: number,
  ) => {
    const steps = curveSteps(r, Math.PI / 2);
    for (let index = 1; index <= steps; index += 1) {
      const angle = startAngle + index * Math.PI / 2 / steps;
      lineTo(centerX + Math.cos(angle) * r, centerY + Math.sin(angle) * r);
    }
  };
  lineTo(width - r, 0);
  arcTo(width - r, r, -Math.PI / 2);
  lineTo(width, height - r);
  arcTo(width - r, height - r, 0);
  lineTo(r, height);
  arcTo(r, height - r, Math.PI / 2);
  lineTo(0, r);
  arcTo(r, r, Math.PI);
  points.pop();
  return points;
}

function strokePathPoints(
  kind: StrokePathKind,
  width: number,
  height: number,
  radius: number,
): StrokePoint[] {
  switch (kind) {
    case "CIRCLE":
    case "ELLIPSE":
      return ellipsePath(width, height);
    case "ROUND_RECT":
      return roundedRectPath(width, height, radius);
    case "TRIANGLE":
      return [
        { x: width / 2, y: 0, edge: 0 },
        { x: width, y: height, edge: 1 },
        { x: 0, y: height, edge: 2 },
      ];
    case "RECT":
      return [
        { x: 0, y: 0, edge: 0 },
        { x: width, y: 0, edge: 1 },
        { x: width, y: height, edge: 2 },
        { x: 0, y: height, edge: 3 },
      ];
  }
}

function strokePieces(
  points: StrokePoint[],
  dash: PortalDashStyle,
  strokeWidth: number,
) {
  if (strokeWidth <= 0) {
    return {
      pieces: [] as StrokePiece[],
      groupCount: 0,
      exceeded: false,
      perimeter: 0,
      wraps: false,
    };
  }
  const contract = dashContract(dash, strokeWidth);
  const period = contract.length + contract.gap;
  const pieces: StrokePiece[] = [];
  const groups = new Set<number>();
  let exceeded = false;
  let edgeStart = 0;
  for (let edge = 0; edge < points.length; edge += 1) {
    const start = points[edge]!;
    const end = points[(edge + 1) % points.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const edgeLength = Math.hypot(dx, dy);
    if (edgeLength <= Number.EPSILON) continue;
    const append = (from: number, to: number, group: number) => {
      if (to - from <= Number.EPSILON || exceeded) return;
      if (pieces.length >= MAX_STROKE_PIECES) {
        exceeded = true;
        return;
      }
      const startRatio = (from - edgeStart) / edgeLength;
      const endRatio = (to - edgeStart) / edgeLength;
      pieces.push({
        start: {
          x: start.x + dx * startRatio,
          y: start.y + dy * startRatio,
          edge: start.edge,
        },
        end: {
          x: start.x + dx * endRatio,
          y: start.y + dy * endRatio,
          edge: start.edge,
        },
        group,
        pathStart: from,
        pathEnd: to,
      });
      groups.add(group);
    };
    const edgeEnd = edgeStart + edgeLength;
    if (dash === "SOLID") {
      append(edgeStart, edgeEnd, 0);
    } else {
      const firstPattern = Math.max(0, Math.floor(edgeStart / period) - 1);
      for (
        let pattern = firstPattern;
        pattern * period < edgeEnd && !exceeded;
        pattern += 1
      ) {
        const dashStart = pattern * period;
        append(
          Math.max(edgeStart, dashStart),
          Math.min(edgeEnd, dashStart + contract.length),
          pattern,
        );
      }
    }
    edgeStart = edgeEnd;
    if (exceeded) break;
  }
  const first = pieces[0];
  const last = pieces.at(-1);
  const wraps = !exceeded &&
    first?.pathStart === 0 &&
    last !== undefined &&
    Math.abs(last.pathEnd - edgeStart) <= 1e-6 &&
    first.group !== last.group;
  return {
    pieces,
    groupCount: Math.max(0, groups.size - (wraps ? 1 : 0)),
    exceeded,
    perimeter: edgeStart,
    wraps,
  };
}

function pathNumber(value: number) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(3)).toString();
}

function polygonPath(piece: StrokePiece, halfWidth: number, offset: number) {
  const dx = piece.end.x - piece.start.x;
  const dy = piece.end.y - piece.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= Number.EPSILON) return "";
  const normalX = -dy / length * halfWidth;
  const normalY = dx / length * halfWidth;
  const points = [
    [piece.start.x + normalX + offset, piece.start.y + normalY + offset],
    [piece.end.x + normalX + offset, piece.end.y + normalY + offset],
    [piece.end.x - normalX + offset, piece.end.y - normalY + offset],
    [piece.start.x - normalX + offset, piece.start.y - normalY + offset],
  ];
  const tokens = points.flatMap(([x, y]) => [pathNumber(x!), pathNumber(y!)]);
  if (tokens.some((token) => token === null)) return null;
  return `M ${tokens[0]} ${tokens[1]} L ${tokens[2]} ${tokens[3]} L ${tokens[4]} ${tokens[5]} L ${tokens[6]} ${tokens[7]} Z`;
}

function circlePath(point: StrokePoint, radius: number, offset: number) {
  const centerX = pathNumber(point.x + offset);
  const centerY = pathNumber(point.y + offset);
  const left = pathNumber(point.x + offset - radius);
  const right = pathNumber(point.x + offset + radius);
  const safeRadius = pathNumber(radius);
  if ([centerX, centerY, left, right, safeRadius].some((token) => token === null)) {
    return null;
  }
  return `M ${left} ${centerY} A ${safeRadius} ${safeRadius} 0 1 0 ${right} ${centerY} A ${safeRadius} ${safeRadius} 0 1 0 ${left} ${centerY} Z`;
}

function clipPathGeometry(
  points: StrokePoint[],
  pieces: StrokePiece[],
  kind: StrokePathKind,
  dash: PortalDashStyle,
  strokeWidth: number,
  perimeter: number,
  wraps: boolean,
) {
  const halfWidth = strokeWidth / 2;
  const commands: string[] = [];
  let length = 0;
  const append = (command: string | null) => {
    if (command === null) return false;
    if (length + command.length + 1 > MAX_CLIP_PATH_CHARS) return false;
    commands.push(command);
    length += command.length + 1;
    return true;
  };
  for (const piece of pieces) {
    if (!append(polygonPath(piece, halfWidth, halfWidth))) return null;
  }

  const groups = new Map<number, StrokePiece[]>();
  for (const piece of pieces) {
    const group = groups.get(piece.group) ?? [];
    group.push(piece);
    groups.set(piece.group, group);
  }
  const firstPiece = pieces[0];
  const lastPiece = pieces.at(-1);
  for (const group of groups.values()) {
    if (kind !== "TRIANGLE") {
      for (let index = 1; index < group.length; index += 1) {
        const previous = group[index - 1]!;
        const current = group[index]!;
        if (
          Math.abs(previous.pathEnd - current.pathStart) <= 1e-6 &&
          !append(circlePath(current.start, halfWidth, halfWidth))
        ) {
          return null;
        }
      }
    }
    if (dash === "DOTTED") {
      const groupFirst = group[0]!;
      const groupLast = group.at(-1)!;
      const skipStartCap = wraps && groupFirst === firstPiece;
      const skipEndCap = wraps && groupLast === lastPiece;
      if (
        (!skipStartCap &&
          !append(circlePath(groupFirst.start, halfWidth, halfWidth))) ||
        (!skipEndCap &&
          !append(circlePath(groupLast.end, halfWidth, halfWidth)))
      ) {
        return null;
      }
    }
  }
  if (
    wraps &&
    firstPiece !== undefined &&
    lastPiece !== undefined &&
    Math.abs(firstPiece.pathStart) <= 1e-6 &&
    Math.abs(lastPiece.pathEnd - perimeter) <= 1e-6 &&
    !append(circlePath(firstPiece.start, halfWidth, halfWidth))
  ) {
    return null;
  }

  if (kind === "TRIANGLE") {
    const contract = dashContract(dash, strokeWidth);
    const period = contract.length + contract.gap;
    let distance = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      const active = dash === "SOLID" ||
        (period > 0 && distance % period < contract.length);
      if (active && !append(circlePath(point, halfWidth, halfWidth))) return null;
      const next = points[(index + 1) % points.length]!;
      distance += Math.hypot(next.x - point.x, next.y - point.y);
    }
  }
  return commands.join(" ");
}

function TriangleStrokeFallback({
  width,
  height,
  color,
  strokeWidth,
  dash,
}: {
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  dash: PortalDashStyle;
}) {
  const points = [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const contract = dashContract(dash, strokeWidth);
  const period = contract.length + contract.gap;
  let pathOffset = 0;
  return points.map((start, index) => {
    const end = points[(index + 1) % points.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const phase = period > 0 ? -(pathOffset % period) : 0;
    pathOffset += length;
    return (
      <span
        key={index}
        aria-hidden="true"
        className={styles.fallbackTriangleSide}
        data-fallback-side={index}
        style={{
          left: start.x + strokeWidth / 2,
          top: start.y,
          width: length,
          height: strokeWidth,
          background: dash === "SOLID"
            ? color
            : `repeating-linear-gradient(90deg, ${color} 0 ${contract.length}px, transparent ${contract.length}px ${period}px)`,
          backgroundPositionX: phase,
          borderRadius: dash === "DOTTED" ? strokeWidth / 2 : 0,
          transform: `rotate(${angle}deg)`,
        }}
      />
    );
  });
}

function DomStrokePath({
  kind,
  width,
  height,
  radius,
  color,
  strokeWidth,
  dash,
}: {
  kind: StrokePathKind;
  width: number;
  height: number;
  radius: number;
  color: string;
  strokeWidth: number;
  dash: PortalDashStyle;
}) {
  const contract = dashContract(dash, strokeWidth);
  const points = strokePathPoints(kind, width, height, radius);
  const geometry = strokePieces(points, dash, strokeWidth);
  const path = geometry.exceeded
    ? null
    : clipPathGeometry(
        points,
        geometry.pieces,
        kind,
        dash,
        strokeWidth,
        geometry.perimeter,
        geometry.wraps,
      );
  const halfWidth = strokeWidth / 2;
  const fallbackRadius = kind === "CIRCLE" || kind === "ELLIPSE"
    ? "50%"
    : kind === "ROUND_RECT"
      ? radius + halfWidth
      : halfWidth;
  const fallback = geometry.exceeded
    ? "piece-budget"
    : path === null
      ? "path-budget"
      : undefined;
  return (
    <span
      aria-hidden="true"
      className={styles.domStrokePath}
      data-dom-stroke-path=""
      data-dash-pattern={contract.serialized}
      data-path-kind={kind}
      data-group-count={geometry.groupCount}
      data-segment-count={geometry.pieces.length}
      data-stroke-fallback={fallback}
      style={{
        left: -halfWidth,
        top: -halfWidth,
        width: `calc(100% + ${strokeWidth}px)`,
        height: `calc(100% + ${strokeWidth}px)`,
        backgroundColor: fallback === undefined ? color : undefined,
        clipPath: fallback === undefined ? `path("${path}")` : undefined,
        ...(fallback === undefined || kind === "TRIANGLE"
          ? {}
          : {
              boxSizing: "border-box",
              border: `${strokeWidth}px ${
                dash === "DOTTED" ? "dotted" : "dashed"
              } ${color}`,
              borderRadius: fallbackRadius,
            }),
      }}
    >
      {fallback !== undefined && kind === "TRIANGLE" && (
        <TriangleStrokeFallback
          width={width}
          height={height}
          color={color}
          strokeWidth={strokeWidth}
          dash={dash}
        />
      )}
    </span>
  );
}

function ShapeVisual({
  element,
}: {
  element: Extract<
    PortalElement,
    { type: "RECT" | "CIRCLE" | "ELLIPSE" | "ROUND_RECT" | "TRIANGLE" }
  >;
}) {
  const radius = element.type === "ROUND_RECT"
    ? effectiveCornerRadius(element)
    : element.type === "CIRCLE" || element.type === "ELLIPSE"
      ? "50%" as const
      : 0;
  const pathRadius = element.type === "ROUND_RECT"
    ? effectiveCornerRadius(element)
    : 0;
  const fillColor = element.fillEnabled
    ? (element.fill ?? element.lastFillColor)
    : undefined;
  return (
    <span
      className={styles.shapeRoot}
      data-portal-visual-box=""
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        filter: dropShadow(element.shadow),
      }}
    >
      <span
        className={element.type === "TRIANGLE" ? styles.triangleFill : styles.shapeFill}
        data-portal-fill=""
        data-fill-enabled={element.fillEnabled ? "true" : "false"}
        style={{
          width: "100%",
          height: "100%",
          background: fillColor ?? "transparent",
          borderRadius: radius,
        }}
      />
      {element.stroke !== null && (
        element.dash === "SOLID" && element.type !== "TRIANGLE"
          ? (
            <CenteredStroke
              color={element.stroke}
              width={element.strokeWidth}
              radius={radius}
            />
          )
          : (
              <DomStrokePath
                kind={element.type}
                width={element.width}
                height={element.height}
                radius={pathRadius}
                color={element.stroke}
                strokeWidth={element.strokeWidth}
                dash={element.dash}
              />
            )
      )}
    </span>
  );
}

function FreehandVisual({
  element,
}: {
  element: Extract<PortalElement, { type: "FREEHAND" }>;
}) {
  return (
    <svg
      className={styles.vector}
      data-portal-vector="FREEHAND"
      viewBox={`0 0 ${Math.max(1, element.width)} ${Math.max(1, element.height)}`}
      aria-hidden="true"
      overflow="visible"
    >
      <path
        d={freehandSvgPath(element.points, element.tension)}
        fill="none"
        stroke={element.stroke}
        strokeWidth={element.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VectorVisual({
  element,
}: {
  element: Extract<PortalElement, { type: "LINE" | "ARROW" }>;
}) {
  const dash = svgDashArray(element.dash, element.strokeWidth);
  if (element.type === "LINE") {
    return (
      <svg
        className={styles.vector}
        data-portal-vector="LINE"
        viewBox={`0 0 ${element.width} ${element.height}`}
        aria-hidden="true"
        style={{ filter: dropShadow(element.shadow) }}
      >
        <line
          x1="0"
          y1="0"
          x2={element.width}
          y2={element.height}
          fill="none"
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const length = Math.hypot(element.width, element.height);
  const unitX = length === 0 ? 1 : element.width / length;
  const unitY = length === 0 ? 0 : element.height / length;
  const baseX = element.width - unitX * element.pointerLength;
  const baseY = element.height - unitY * element.pointerLength;
  const left = {
    x: baseX - unitY * element.pointerWidth / 2,
    y: baseY + unitX * element.pointerWidth / 2,
  };
  const right = {
    x: baseX + unitY * element.pointerWidth / 2,
    y: baseY - unitX * element.pointerWidth / 2,
  };

  return (
    <svg
      className={styles.vector}
      data-portal-vector="ARROW"
      viewBox={`0 0 ${element.width} ${element.height}`}
      aria-hidden="true"
      style={{ filter: dropShadow(element.shadow) }}
    >
      <line
        x1="0"
        y1="0"
        x2={element.width}
        y2={element.height}
        fill="none"
        stroke={element.stroke}
        strokeWidth={element.strokeWidth}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
      <polygon
        data-arrow-head=""
        points={`${left.x},${left.y} ${element.width},${element.height} ${right.x},${right.y}`}
        fill={element.stroke}
        stroke={element.stroke}
        strokeWidth={element.strokeWidth}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MarkerVisual({
  element,
  hitSize,
  canvasWidth,
  canvasHeight,
}: {
  element: Extract<PortalElement, { type: "MARKER" }>;
  hitSize: number;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const disclosureId = `portal-marker-${reactId.replaceAll(":", "")}`;
  const disclosureWidth = Math.min(
    280,
    Math.max(160, element.description.length * 8),
  );
  const estimatedTitleLines = Math.max(1, Math.ceil(element.title.length / 16));
  const estimatedDescriptionLines = Math.max(
    1,
    Math.ceil(element.description.length / 16),
  );
  const disclosureHeight = 36 + estimatedTitleLines * 24 +
    estimatedDescriptionLines * 24;
  const centerX = element.x + element.width / 2;
  const horizontal = centerX <= disclosureWidth / 2 + 10
    ? "LEFT"
    : centerX >= canvasWidth - disclosureWidth / 2 - 10
      ? "RIGHT"
      : "CENTER";
  const roomBelow = Math.max(
    0,
    canvasHeight - element.y - element.height - 10,
  );
  const roomAbove = Math.max(0, element.y - 10);
  const vertical = roomBelow >= disclosureHeight
    ? "BOTTOM"
    : roomAbove >= disclosureHeight
      ? "TOP"
      : roomBelow >= roomAbove
        ? "BOTTOM"
        : "TOP";
  const selectedRoom = vertical === "TOP" ? roomAbove : roomBelow;
  const hitBox = clampedHitBox({
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    hitSize,
    canvasWidth,
    canvasHeight,
  });
  const disclosurePosition: CSSProperties = {
    maxWidth: Math.min(disclosureWidth, canvasWidth - 20),
    maxHeight: selectedRoom,
    boxSizing: "border-box",
    overflowY: "auto",
    overflowWrap: "anywhere",
    ...(vertical === "TOP"
      ? { bottom: "calc(100% + 10px)" }
      : { top: "calc(100% + 10px)" }),
    ...(horizontal === "LEFT"
      ? { left: 0, transform: "none" }
      : horizontal === "RIGHT"
        ? { right: 0, transform: "none" }
        : { left: "50%", transform: "translateX(-50%)" }),
  };
  return (
    <span
      className={styles.marker}
      data-portal-visual-box=""
      style={{ color: element.color, background: element.backgroundColor }}
    >
      <button
        type="button"
        className={styles.interactive}
        data-portal-element-id={element.id}
        aria-label={element.title}
        aria-expanded={open}
        aria-controls={disclosureId}
        style={{ position: "relative", width: "100%", height: "100%" }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.markerLabel}>
          <IconVisual iconName={element.iconName} color={element.color} />
          <span>{element.text}</span>
        </span>
        <span
          aria-hidden="true"
          className={styles.hitSlop}
          data-portal-hit-slop=""
          style={hitBox}
        />
      </button>
      {open && (
        <span
          id={disclosureId}
          role="status"
          className={styles.markerDisclosure}
          data-vertical={vertical}
          data-horizontal={horizontal}
          style={disclosurePosition}
        >
          <strong>{element.title}</strong>
          <span>{element.description}</span>
        </span>
      )}
    </span>
  );
}

function ElementVisual({
  element,
  hitSize,
  canvasWidth,
  canvasHeight,
}: {
  element: PortalElement;
  hitSize: number;
  canvasWidth: number;
  canvasHeight: number;
}) {
  switch (element.type) {
    case "TEXT": {
      const text = (
        <span
          className={styles.text}
          data-portal-visual-box=""
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            color: element.color,
            backgroundColor: element.backgroundColor ?? undefined,
            fontFamily: `"${element.fontFamily}", sans-serif`,
            fontSize: element.fontSize,
            fontWeight: element.fontWeight,
            fontStyle: element.italic ? "italic" : "normal",
            textDecoration: element.underline ? "underline" : "none",
            letterSpacing: element.letterSpacing,
            lineHeight: element.lineHeight,
            textAlign: element.align.toLowerCase() as CSSProperties["textAlign"],
          }}
        >
          {element.text}
        </span>
      );
      return element.action === null
        ? text
        : (
            <ActionSurface
              action={element.action}
              elementId={element.id}
              hitSize={hitSize}
              x={element.x}
              y={element.y}
              rotation={element.rotation}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              visualWidth={element.width}
              visualHeight={element.height}
            >
              {text}
            </ActionSurface>
          );
    }
    case "RECT":
    case "CIRCLE":
    case "ELLIPSE":
    case "ROUND_RECT":
    case "TRIANGLE":
      return <ShapeVisual element={element} />;
    case "LINE":
    case "ARROW":
      return <VectorVisual element={element} />;
    case "FREEHAND":
      return <FreehandVisual element={element} />;
    case "IMAGE": {
      const image = <ImageVisual element={element} />;
      return element.action === null
        ? image
        : (
            <ActionSurface
              action={element.action}
              elementId={element.id}
              label={element.altText}
              hitSize={hitSize}
              x={element.x}
              y={element.y}
              rotation={element.rotation}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              visualWidth={element.width}
              visualHeight={element.height}
            >
              {image}
            </ActionSurface>
          );
    }
    case "ICON": {
      const icon = <IconVisual iconName={element.iconName} color={element.color} />;
      return element.action === null
        ? icon
        : (
            <ActionSurface
              action={element.action}
              elementId={element.id}
              label={element.name}
              hitSize={hitSize}
              x={element.x}
              y={element.y}
              rotation={element.rotation}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              visualWidth={element.width}
              visualHeight={element.height}
            >
              {icon}
            </ActionSurface>
          );
    }
    case "BUTTON": {
      const radius = effectiveCornerRadius(element);
      const justifyContent = element.align === "LEFT"
        ? "flex-start"
        : element.align === "RIGHT"
          ? "flex-end"
          : "center";
      return (
        <ActionSurface
          action={element.action}
          elementId={element.id}
          hitSize={hitSize}
          x={element.x}
          y={element.y}
          rotation={element.rotation}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          visualWidth={element.width}
          visualHeight={element.height}
          className={styles.button}
          style={{
            color: element.color,
            borderRadius: radius,
            fontFamily: `"${element.fontFamily}", sans-serif`,
            fontSize: element.fontSize,
            fontWeight: element.fontWeight,
            lineHeight: element.lineHeight,
            justifyContent,
          }}
        >
          <span
            className={styles.buttonVisual}
            data-portal-visual-box=""
            style={{
              width: "100%",
              height: "100%",
              borderRadius: radius,
              filter: dropShadow(element.shadow),
            }}
          >
            <span
              className={styles.buttonFill}
              style={{
                width: "100%",
                height: "100%",
                borderRadius: radius,
                backgroundColor: element.backgroundColor,
              }}
            />
            {element.border !== null && (
              element.border.dash === "SOLID"
                ? (
                    <CenteredStroke
                      color={element.border.color}
                      width={element.border.width}
                      radius={radius}
                    />
                  )
                : (
                    <DomStrokePath
                      kind="ROUND_RECT"
                      width={element.width}
                      height={element.height}
                      radius={radius}
                      color={element.border.color}
                      strokeWidth={element.border.width}
                      dash={element.border.dash}
                    />
                  )
            )}
            <span
              className={styles.buttonText}
              data-button-text=""
              style={{
                width: "100%",
                color: element.color,
                textAlign: element.align.toLowerCase() as CSSProperties["textAlign"],
              }}
            >
              {element.text}
            </span>
          </span>
        </ActionSurface>
      );
    }
    case "MARKER":
      return (
        <MarkerVisual
          element={element}
          hitSize={hitSize}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
        />
      );
  }
}

export function PublishedScene({
  scene,
  version,
}: {
  scene: unknown;
  version: number;
}) {
  const parsed = useMemo(() => portalSceneV1Schema.safeParse(scene), [scene]);
  const containerRef = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    if (!parsed.success || !containerRef.current) return;
    const container = containerRef.current;
    const update = (width: number) => {
      setScale(publishedScale(width, parsed.data).scale);
    };
    update(container.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) update(width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [parsed]);

  if (!parsed.success) {
    return (
      <p role="alert" className={styles.error}>
        发布内容暂时无法显示，请刷新页面；如仍有问题，请联系管理员重新发布。
      </p>
    );
  }

  const sceneData = parsed.data;
  const { canvasWidth, canvasHeight } = portalSceneCanvasSize(sceneData);
  const safeScale = scale > 0 ? scale : 1;
  const hitSize = 44 / safeScale;
  const backgroundUrl = sceneData.background.assetId === null
    ? undefined
    : `url("${privateAssetUrl(sceneData.background.assetId)}")`;
  const sceneStyle = {
    "--portal-design-width": `${canvasWidth}px`,
    "--portal-design-height": `${canvasHeight}px`,
    "--portal-scale": String(safeScale),
    height: canvasHeight * scale,
  } as CSSProperties;
  const planeStyle: CSSProperties = {
    transform: `scale(${scale})`,
    backgroundColor: sceneData.background.backgroundColor,
    backgroundImage: backgroundUrl,
    backgroundSize: sceneData.background.fitMode === "AUTO_HEIGHT" ? "100% auto" : sceneData.background.fitMode.toLowerCase(),
    backgroundPosition: sceneData.background.fitMode === "AUTO_HEIGHT" ? "left top" : `${sceneData.background.positionX}% ${sceneData.background.positionY}%`,
  };

  return (
    <section
      ref={containerRef}
      role="region"
      aria-label={`四城门户发布版本 ${version}`}
      className={styles.scene}
      style={sceneStyle}
    >
      <div
        className={styles.plane}
        data-testid="published-scene-plane"
        style={planeStyle}
      >
        {[...sceneData.elements]
          .filter((element) => !element.hidden && element.opacity > 0)
          .sort((left, right) =>
            left.zIndex - right.zIndex || left.id.localeCompare(right.id)
          )
          .map((element) => (
              <div
                key={element.id}
                className={styles.element}
                data-portal-element-id={element.id}
                data-portal-element-type={element.type}
                style={{
                  left: element.x,
                  top: element.y,
                  width: element.width,
                  height: element.height,
                  zIndex: element.zIndex,
                  opacity: element.opacity,
                  transform: `rotate(${element.rotation}deg)`,
                }}
              >
                <ElementVisual
                  element={element}
                  hitSize={hitSize}
                  canvasWidth={canvasWidth}
                  canvasHeight={canvasHeight}
                />
              </div>
          ))}
      </div>
    </section>
  );
}

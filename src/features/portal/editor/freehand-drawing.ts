import { elementBounds } from "@/features/portal/portal-geometry";
import type { PortalElement, PortalFreehandElement } from "@/features/portal/portal-scene";

export const FREEHAND_DEFAULT_STROKE = "#1E88E5";
export const FREEHAND_DEFAULT_STROKE_WIDTH = 4;
export const FREEHAND_DEFAULT_TENSION = 0.4;
export const FREEHAND_MAX_POINTS = 4_000;
export const FREEHAND_SAMPLE_DISTANCE = 1.5;

export type AbsolutePoint = { x: number; y: number };

function pointPairs(points: number[]): AbsolutePoint[] {
  const pairs: AbsolutePoint[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    pairs.push({ x: points[index]!, y: points[index + 1]! });
  }
  return pairs;
}

/**
 * Render the stored Konva-style tension path as SVG for preview and employee pages.
 * The Catmull-Rom to cubic Bezier conversion keeps both renderers visually aligned.
 */
export function freehandSvgPath(points: number[], tension: number): string {
  const pairs = pointPairs(points);
  const first = pairs[0];
  if (!first) return "";
  if (pairs.length === 1) return `M ${first.x} ${first.y}`;

  let path = `M ${first.x} ${first.y}`;
  if (tension <= 0) {
    for (const point of pairs.slice(1)) path += ` L ${point.x} ${point.y}`;
    return path;
  }

  const factor = Math.min(1, tension) / 6;
  for (let index = 0; index < pairs.length - 1; index += 1) {
    const previous = pairs[index - 1] ?? pairs[index]!;
    const current = pairs[index]!;
    const next = pairs[index + 1]!;
    const following = pairs[index + 2] ?? next;
    const control1 = {
      x: current.x + (next.x - previous.x) * factor,
      y: current.y + (next.y - previous.y) * factor,
    };
    const control2 = {
      x: next.x - (following.x - current.x) * factor,
      y: next.y - (following.y - current.y) * factor,
    };
    path += ` C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`;
  }
  return path;
}

function idForFreehand() {
  const suffix = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `freehand-${suffix}`.slice(0, 100);
}

export function shouldAppendFreehandPoint(
  points: AbsolutePoint[],
  next: AbsolutePoint,
  minDistance = FREEHAND_SAMPLE_DISTANCE,
) {
  const last = points[points.length - 1];
  if (!last) return true;
  return Math.hypot(next.x - last.x, next.y - last.y) >= minDistance;
}

export function appendFreehandPoint(
  points: AbsolutePoint[],
  next: AbsolutePoint,
  minDistance = FREEHAND_SAMPLE_DISTANCE,
): AbsolutePoint[] {
  if (points.length * 2 >= FREEHAND_MAX_POINTS) return points;
  if (!shouldAppendFreehandPoint(points, next, minDistance)) return points;
  return [...points, next];
}

/**
 * Translate (and if needed uniformly shrink) a freehand element so its rendered
 * stroke bounds stay inside the canvas without crushing relative path points.
 */
function fitFreehandElementToCanvas(
  element: Extract<PortalElement, { type: "FREEHAND" }>,
  canvasWidth: number,
  canvasHeight: number,
): Extract<PortalElement, { type: "FREEHAND" }> {
  let fitted = element;
  let bounds = elementBounds(fitted);
  const scale = Math.min(
    1,
    canvasWidth / Math.max(bounds.width, 1e-9),
    canvasHeight / Math.max(bounds.height, 1e-9),
  );
  if (scale < 1) {
    fitted = {
      ...scaleFreehandElementGeometry(fitted, {
        x: fitted.x,
        y: fitted.y,
        width: Math.max(1, fitted.width * scale),
        height: Math.max(1, fitted.height * scale),
        rotation: fitted.rotation,
      }),
      strokeWidth: Math.max(0.1, fitted.strokeWidth * scale),
    };
    bounds = elementBounds(fitted);
  }

  let x = fitted.x;
  let y = fitted.y;
  if (bounds.x < 0) x -= bounds.x;
  else if (bounds.x + bounds.width > canvasWidth) x -= bounds.x + bounds.width - canvasWidth;
  if (bounds.y < 0) y -= bounds.y;
  else if (bounds.y + bounds.height > canvasHeight) y -= bounds.y + bounds.height - canvasHeight;

  x = Math.max(0, Math.min(x, canvasWidth - fitted.width));
  y = Math.max(0, Math.min(y, canvasHeight - fitted.height));
  return { ...fitted, x, y };
}

/**
 * Convert absolute canvas stroke samples into a bounded FREEHAND element.
 * Returns null when the stroke is too short to form a valid path.
 */
export function buildFreehandElementFromStroke(
  absolutePoints: AbsolutePoint[],
  options: {
    canvasWidth: number;
    canvasHeight: number;
    zIndex: number;
    stroke?: string;
    strokeWidth?: number;
    tension?: number;
    opacity?: number;
  },
): Extract<PortalElement, { type: "FREEHAND" }> | null {
  if (absolutePoints.length < 2) return null;

  const xs = absolutePoints.map(({ x }) => x);
  const ys = absolutePoints.map(({ y }) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  let maxX = Math.max(...xs);
  let maxY = Math.max(...ys);

  // Degenerate strokes still need a 1×1 design box so schema validation passes.
  if (maxX - minX < 1) maxX = minX + 1;
  if (maxY - minY < 1) maxY = minY + 1;

  const canvasWidth = Math.max(1, options.canvasWidth);
  const canvasHeight = Math.max(1, options.canvasHeight);
  const strokeWidth = options.strokeWidth ?? FREEHAND_DEFAULT_STROKE_WIDTH;
  const width = maxX - minX;
  const height = maxY - minY;

  // Keep relative geometry faithful to the sampled stroke (no edge-box shift that crushes points).
  const points = absolutePoints.flatMap(({ x, y }) => [x - minX, y - minY]);

  // Cap pair count to schema max while preserving endpoints.
  let capped = points;
  if (capped.length > FREEHAND_MAX_POINTS) {
    const head = capped.slice(0, FREEHAND_MAX_POINTS - 2);
    const tail = capped.slice(-2);
    capped = [...head, ...tail];
  }

  const built = {
    id: idForFreehand(),
    name: "自由绘制",
    type: "FREEHAND" as const,
    x: minX,
    y: minY,
    width,
    height,
    rotation: 0,
    opacity: options.opacity ?? 1,
    zIndex: options.zIndex,
    locked: false,
    hidden: false,
    points: capped,
    stroke: options.stroke ?? FREEHAND_DEFAULT_STROKE,
    strokeWidth,
    tension: options.tension ?? FREEHAND_DEFAULT_TENSION,
    lineCap: "ROUND" as const,
    lineJoin: "ROUND" as const,
  };

  return fitFreehandElementToCanvas(built, canvasWidth, canvasHeight);
}

/** Scale freehand path points when the element box is resized (non-uniform allowed). */
export function scaleFreehandElementGeometry(
  element: PortalFreehandElement,
  next: Pick<PortalFreehandElement, "x" | "y" | "width" | "height" | "rotation">,
): PortalFreehandElement {
  const scaleX = element.width === 0 ? 1 : next.width / element.width;
  const scaleY = element.height === 0 ? 1 : next.height / element.height;
  if (scaleX === 1 && scaleY === 1) {
    return { ...element, ...next };
  }
  return {
    ...element,
    ...next,
    points: element.points.map((value, index) =>
      index % 2 === 0 ? value * scaleX : value * scaleY),
  };
}

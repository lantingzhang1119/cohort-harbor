import type {
  PortalDashStyle,
  PortalElement,
  PortalImageElement,
  PortalLineElement,
  PortalShadow,
  PortalViewportInput,
} from "@/features/portal/portal-scene";

export type ElementBounds = { x: number; y: number; width: number; height: number };

function normalizedFloat(value: number) {
  const rounded = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function rotatePoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
  degrees: number,
) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: normalizedFloat(center.x + dx * cosine - dy * sine),
    y: normalizedFloat(center.y + dx * sine + dy * cosine),
  };
}

function shapeStrokeRadius(element: PortalElement) {
  switch (element.type) {
    case "RECT":
    case "CIRCLE":
    case "ELLIPSE":
    case "ROUND_RECT":
    case "TRIANGLE":
      return element.stroke === null ? 0 : element.strokeWidth / 2;
    case "BUTTON":
      return element.border === null ? 0 : element.border.width / 2;
    default:
      return 0;
  }
}

function elementShadow(element: PortalElement): PortalShadow | null {
  switch (element.type) {
    case "RECT":
    case "CIRCLE":
    case "ELLIPSE":
    case "ROUND_RECT":
    case "TRIANGLE":
    case "LINE":
    case "ARROW":
    case "BUTTON":
      return element.shadow;
    default:
      return null;
  }
}

export function portalDashPattern(dash: PortalDashStyle, width: number) {
  const unit = Math.max(0.5, width);
  if (dash === "DASHED") return [unit * 4, unit * 3];
  if (dash === "DOTTED") return [unit, unit * 2];
  return [];
}

export function effectiveCornerRadius(element: PortalElement) {
  const requested = element.type === "ROUND_RECT"
    || element.type === "IMAGE"
    || element.type === "BUTTON"
    ? element.cornerRadius
    : 0;
  return normalizedFloat(Math.min(requested, element.width / 2, element.height / 2));
}

export function portalShadowFootprint(shadow: PortalShadow | null) {
  if (shadow === null || shadow.opacity === 0) {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  return {
    left: Math.max(0, shadow.blur - shadow.offsetX),
    right: Math.max(0, shadow.blur + shadow.offsetX),
    top: Math.max(0, shadow.blur - shadow.offsetY),
    bottom: Math.max(0, shadow.blur + shadow.offsetY),
  };
}

function pointsBounds(points: { x: number; y: number }[], radius: number): ElementBounds {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const left = Math.min(...xs) - radius;
  const top = Math.min(...ys) - radius;
  return {
    x: normalizedFloat(left),
    y: normalizedFloat(top),
    width: normalizedFloat(Math.max(...xs) + radius - left),
    height: normalizedFloat(Math.max(...ys) + radius - top),
  };
}

function unionBounds(left: ElementBounds, right: ElementBounds): ElementBounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const farX = Math.max(left.x + left.width, right.x + right.width);
  const farY = Math.max(left.y + left.height, right.y + right.height);
  return {
    x: normalizedFloat(x),
    y: normalizedFloat(y),
    width: normalizedFloat(farX - x),
    height: normalizedFloat(farY - y),
  };
}

function renderedPointBounds(
  points: { x: number; y: number }[],
  center: { x: number; y: number },
  rotation: number,
  radius: number,
  shadow: PortalShadow | null,
) {
  const base = pointsBounds(
    points.map((point) => rotatePoint(point, center, rotation)),
    radius,
  );
  if (shadow === null || shadow.opacity === 0) return base;
  const shadowPoints = points.map((point) => rotatePoint({
    x: point.x + shadow.offsetX,
    y: point.y + shadow.offsetY,
  }, center, rotation));
  return unionBounds(base, pointsBounds(shadowPoints, radius + shadow.blur));
}

export function portalCanvasSize(viewport: PortalViewportInput) {
  return viewport === "DESKTOP"
    ? { canvasWidth: 1_440, canvasHeight: 900 }
    : { canvasWidth: 390, canvasHeight: 844 };
}

export function portalSceneCanvasSize(scene: {
  viewport: PortalViewportInput;
  background?: {
    fitMode?: unknown;
    naturalWidth?: unknown;
    naturalHeight?: unknown;
  } | null;
}) {
  const fixed = portalCanvasSize(scene.viewport);
  const naturalWidth = scene.background?.naturalWidth;
  const naturalHeight = scene.background?.naturalHeight;
  if (
    scene.background?.fitMode !== "AUTO_HEIGHT"
    || typeof naturalWidth !== "number"
    || typeof naturalHeight !== "number"
    || !Number.isFinite(naturalWidth)
    || !Number.isFinite(naturalHeight)
    || naturalWidth <= 0
    || naturalHeight <= 0
  ) return fixed;
  return {
    canvasWidth: fixed.canvasWidth,
    canvasHeight: normalizedFloat(fixed.canvasWidth * naturalHeight / naturalWidth),
  };
}

export function elementBounds(element: PortalElement): ElementBounds {
  if (element.type === "LINE" || element.type === "ARROW") {
    const center = {
      x: element.x + element.width / 2,
      y: element.y + element.height / 2,
    };
    const start = { x: element.x, y: element.y };
    const end = { x: element.x + element.width, y: element.y + element.height };
    const points = [start, end];

    if (element.type === "ARROW") {
      const length = Math.hypot(element.width, element.height);
      const unitX = length === 0 ? 1 : element.width / length;
      const unitY = length === 0 ? 0 : element.height / length;
      const base = {
        x: end.x - unitX * element.pointerLength,
        y: end.y - unitY * element.pointerLength,
      };
      points.push(
        {
          x: base.x - unitY * element.pointerWidth / 2,
          y: base.y + unitX * element.pointerWidth / 2,
        },
        {
          x: base.x + unitY * element.pointerWidth / 2,
          y: base.y - unitX * element.pointerWidth / 2,
        },
      );
    }

    return renderedPointBounds(
      points,
      center,
      element.rotation,
      element.strokeWidth / 2,
      element.shadow,
    );
  }

  if (element.type === "FREEHAND") {
    const center = {
      x: element.x + element.width / 2,
      y: element.y + element.height / 2,
    };
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index + 1 < element.points.length; index += 2) {
      points.push({
        x: element.x + element.points[index]!,
        y: element.y + element.points[index + 1]!,
      });
    }
    if (points.length === 0) {
      points.push(
        { x: element.x, y: element.y },
        { x: element.x + element.width, y: element.y + element.height },
      );
    }
    return renderedPointBounds(
      points,
      center,
      element.rotation,
      element.strokeWidth / 2,
      null,
    );
  }

  const strokeRadius = shapeStrokeRadius(element);
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  const corners = [
    { x: element.x, y: element.y },
    { x: element.x + element.width, y: element.y },
    { x: element.x + element.width, y: element.y + element.height },
    { x: element.x, y: element.y + element.height },
  ];
  return renderedPointBounds(
    corners,
    center,
    element.rotation,
    strokeRadius,
    elementShadow(element),
  );
}

export function arrowGeometry(element: PortalLineElement) {
  const center = {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
  };
  const start = rotatePoint({ x: element.x, y: element.y }, center, element.rotation);
  const end = rotatePoint({
    x: element.x + element.width,
    y: element.y + element.height,
  }, center, element.rotation);
  return {
    points: [0, 0, element.width, element.height],
    start,
    end,
    pointerLength: element.type === "ARROW" ? element.pointerLength : 0,
    pointerWidth: element.type === "ARROW" ? element.pointerWidth : 0,
  };
}

export function publishedScale(
  containerWidth: number,
  viewportOrScene: PortalViewportInput | Parameters<typeof portalSceneCanvasSize>[0],
) {
  const size = typeof viewportOrScene === "string"
    ? portalCanvasSize(viewportOrScene)
    : portalSceneCanvasSize(viewportOrScene);
  const safeWidth = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const scale = Math.min(1, safeWidth / size.canvasWidth);
  return { scale, renderedHeight: size.canvasHeight * scale };
}

export function imageRenderGeometry(
  element: PortalImageElement,
  image: { naturalWidth: number; naturalHeight: number },
) {
  const crop = {
    x: image.naturalWidth * element.crop.x,
    y: image.naturalHeight * element.crop.y,
    width: image.naturalWidth * element.crop.width,
    height: image.naturalHeight * element.crop.height,
  };

  if (element.fitMode === "CONTAIN") {
    const scale = Math.min(element.width / crop.width, element.height / crop.height);
    const width = crop.width * scale;
    const height = crop.height * scale;
    return {
      x: (element.width - width) / 2,
      y: (element.height - height) / 2,
      width,
      height,
      crop,
    };
  }

  const frameAspect = element.width / element.height;
  const cropAspect = crop.width / crop.height;
  if (cropAspect > frameAspect) {
    const width = crop.height * frameAspect;
    crop.x += (crop.width - width) / 2;
    crop.width = width;
  } else if (cropAspect < frameAspect) {
    const height = crop.width / frameAspect;
    crop.y += (crop.height - height) / 2;
    crop.height = height;
  }
  return { x: 0, y: 0, width: element.width, height: element.height, crop };
}

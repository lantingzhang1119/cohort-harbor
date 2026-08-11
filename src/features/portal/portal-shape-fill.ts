export const CLOSED_SHAPE_TYPES = [
  "RECT",
  "CIRCLE",
  "ELLIPSE",
  "ROUND_RECT",
  "TRIANGLE",
] as const;

export type ClosedShapeType = (typeof CLOSED_SHAPE_TYPES)[number];

export type ClosedShapeFillFields = {
  fillEnabled: boolean;
  fill: string | null;
  lastFillColor: string;
};

const DEFAULT_LAST_FILL = "#DCEBFA";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClosedShapeType(type: unknown): type is ClosedShapeType {
  return typeof type === "string"
    && (CLOSED_SHAPE_TYPES as readonly string[]).includes(type);
}

export function normalizeClosedShapeFillFields(
  element: Record<string, unknown>,
): Record<string, unknown> {
  if (!isClosedShapeType(element.type)) return element;

  const fillEnabled = typeof element.fillEnabled === "boolean"
    ? element.fillEnabled
    : true;
  const rawFill = typeof element.fill === "string" ? element.fill : null;
  const lastFillColor = typeof element.lastFillColor === "string"
    ? element.lastFillColor
    : (rawFill ?? DEFAULT_LAST_FILL);
  const fill = fillEnabled ? (rawFill ?? lastFillColor) : null;

  return {
    ...element,
    fillEnabled,
    fill,
    lastFillColor,
  };
}

export function normalizeClosedShapeFillInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return normalizeClosedShapeFillFields(value);
}

export function resolveClosedShapeFill(
  fields: {
    fillEnabled: boolean;
    fill: string | null;
    lastFillColor?: string;
  },
): { fill: string | undefined } {
  if (!fields.fillEnabled) {
    return { fill: undefined };
  }
  return { fill: fields.fill ?? fields.lastFillColor ?? DEFAULT_LAST_FILL };
}

export function closedShapeFillStyle(
  fields: {
    fillEnabled: boolean;
    fill: string | null;
    lastFillColor?: string;
    forHitTesting?: boolean;
  },
): { fill: string | undefined; fillEnabled: boolean } {
  if (fields.fillEnabled) {
    return {
      fill: fields.fill ?? fields.lastFillColor ?? DEFAULT_LAST_FILL,
      fillEnabled: true,
    };
  }
  return {
    fill: undefined,
    fillEnabled: false,
  };
}

export function disableClosedShapeFill(
  fields: {
    fill?: string | null;
    lastFillColor?: string;
  },
): ClosedShapeFillFields {
  const lastFillColor = fields.fill ?? fields.lastFillColor ?? DEFAULT_LAST_FILL;
  return {
    fillEnabled: false,
    fill: null,
    lastFillColor,
  };
}

export function enableClosedShapeFill(
  fields: {
    lastFillColor?: string;
  },
): ClosedShapeFillFields {
  const lastFillColor = fields.lastFillColor || DEFAULT_LAST_FILL;
  return {
    fillEnabled: true,
    fill: lastFillColor,
    lastFillColor,
  };
}

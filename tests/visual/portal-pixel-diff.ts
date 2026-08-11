import sharp from "sharp";

/**
 * Decode two PNGs, normalize to the same pixel grid, and return the share of
 * pixels whose RGB channels differ by more than `channelTolerance`.
 *
 * Threshold guidance for Task9:
 * - High-information office-map crops should pass with
 *   channelTolerance = 0 and ratio < 0.01 (1%).
 * - Never use compressed-byte similarity as a substitute for this decode path.
 */
export async function rgbaPixelDiffRatio(
  leftPng: Buffer,
  rightPng: Buffer,
  options: {
    width: number;
    height: number;
    channelTolerance?: number;
  },
) {
  const width = Math.max(1, Math.trunc(options.width));
  const height = Math.max(1, Math.trunc(options.height));
  const channelTolerance = Math.max(0, options.channelTolerance ?? 0);

  const [left, right] = await Promise.all([
    sharp(leftPng)
      .resize(width, height, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer(),
    sharp(rightPng)
      .resize(width, height, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer(),
  ]);

  const pixelCount = width * height;
  let different = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (
      Math.abs(left[offset]! - right[offset]!) > channelTolerance
      || Math.abs(left[offset + 1]! - right[offset + 1]!) > channelTolerance
      || Math.abs(left[offset + 2]! - right[offset + 2]!) > channelTolerance
    ) {
      different += 1;
    }
  }
  return different / pixelCount;
}

export type ColorMaskBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  width: number;
  height: number;
};

/** Locate solid/high-contrast paint by RGB mask on a PNG (device pixels). */
export async function locateColorMaskBounds(
  png: Buffer,
  color: { r: number; g: number; b: number },
  tolerance = 48,
): Promise<ColorMaskBounds | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const alpha = info.channels > 3 ? data[offset + 3]! : 255;
      if (alpha < 16) continue;
      if (
        Math.abs(data[offset]! - color.r) <= tolerance
        && Math.abs(data[offset + 1]! - color.g) <= tolerance
        && Math.abs(data[offset + 2]! - color.b) <= tolerance
      ) {
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 12 || maxX < 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    count,
    width: info.width,
    height: info.height,
  };
}

export type StrokeEndpoints = {
  /** Device-pixel start (leftmost paint cluster centroid). */
  start: { x: number; y: number };
  /** Device-pixel end (rightmost paint cluster centroid). */
  end: { x: number; y: number };
  bounds: ColorMaskBounds;
};

/**
 * Locate real stroke endpoints from a color mask: average y of the leftmost /
 * rightmost paint columns (not AABB vertical center). Requires end.x > start.x
 * for left-to-right orientation.
 */
export async function locateColorStrokeEndpoints(
  png: Buffer,
  color: { r: number; g: number; b: number },
  tolerance = 28,
): Promise<StrokeEndpoints | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const matches: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const alpha = info.channels > 3 ? data[offset + 3]! : 255;
      if (alpha < 16) continue;
      if (
        Math.abs(data[offset]! - color.r) <= tolerance
        && Math.abs(data[offset + 1]! - color.g) <= tolerance
        && Math.abs(data[offset + 2]! - color.b) <= tolerance
      ) {
        matches.push({ x, y });
      }
    }
  }
  if (matches.length < 8) return null;

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (const point of matches) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (maxX < 0 || maxX <= minX) return null;

  // Column bands (1px, expand to 2 if sparse) for endpoint centroids.
  const band = Math.max(1, Math.round((maxX - minX) * 0.02));
  const left = matches.filter((point) => point.x <= minX + band);
  const right = matches.filter((point) => point.x >= maxX - band);
  if (left.length === 0 || right.length === 0) return null;

  const centroid = (points: Array<{ x: number; y: number }>) => {
    let sx = 0;
    let sy = 0;
    for (const point of points) {
      sx += point.x;
      sy += point.y;
    }
    return { x: sx / points.length, y: sy / points.length };
  };
  const start = centroid(left);
  const end = centroid(right);
  if (!(end.x > start.x)) return null;

  return {
    start,
    end,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      count: matches.length,
      width: info.width,
      height: info.height,
    },
  };
}

export type ImageContentStats = {
  uniqueColors: number;
  stdDev: number;
  edgeEnergy: number;
};

/** Sample stats proving a crop is real image content, not letterbox/empty fill. */
export async function measureImageContentStats(png: Buffer): Promise<ImageContentStats> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  const unique = new Set<string>();
  let sum = 0;
  let sumSq = 0;
  let edge = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      unique.add(`${r >> 3},${g >> 3},${b >> 3}`);
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += luma;
      sumSq += luma * luma;
      if (x + 1 < info.width) {
        const n = ((y * info.width + (x + 1)) * info.channels);
        const nl = 0.299 * data[n]! + 0.587 * data[n + 1]! + 0.114 * data[n + 2]!;
        edge += Math.abs(luma - nl);
      }
      if (y + 1 < info.height) {
        const n = (((y + 1) * info.width + x) * info.channels);
        const nl = 0.299 * data[n]! + 0.587 * data[n + 1]! + 0.114 * data[n + 2]!;
        edge += Math.abs(luma - nl);
      }
    }
  }

  const mean = sum / pixelCount;
  const variance = Math.max(0, sumSq / pixelCount - mean * mean);
  return {
    uniqueColors: unique.size,
    stdDev: Math.sqrt(variance),
    edgeEnergy: edge / pixelCount,
  };
}

export function assertHighInformationCrop(
  stats: ImageContentStats,
  label: string,
) {
  // Solid letterbox / empty fill fails these gates; office-map content passes.
  if (stats.uniqueColors < 24) {
    throw new Error(`${label}: uniqueColors=${stats.uniqueColors} (<24) — empty/letterbox crop`);
  }
  if (stats.stdDev < 8) {
    throw new Error(`${label}: stdDev=${stats.stdDev.toFixed(2)} (<8) — empty/letterbox crop`);
  }
  if (stats.edgeEnergy < 2) {
    throw new Error(`${label}: edgeEnergy=${stats.edgeEnergy.toFixed(2)} (<2) — empty/letterbox crop`);
  }
}

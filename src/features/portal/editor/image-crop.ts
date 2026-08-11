export type NormalizedCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CropSize = {
  width: number;
  height: number;
};

export type CropPoint = {
  x: number;
  y: number;
};

export type ImageCropFitMode = "CONTAIN" | "COVER";

export type CropRenderContext = {
  fitMode: ImageCropFitMode;
  source: CropSize;
  frame: CropSize;
};

export const MIN_CROP_EDGE = 0.01;
const FULL_CROP: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 };

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validSize(size: CropSize) {
  return {
    width: Math.max(Number.EPSILON, finiteOr(size.width, 1)),
    height: Math.max(Number.EPSILON, finiteOr(size.height, 1)),
  };
}

/**
 * Normalize a persisted source rectangle as a coupled unit. Position is
 * constrained by the already-normalized dimensions, so x + width and
 * y + height can never escape the 0..1 source space.
 */
export function clampCrop(crop: NormalizedCrop): NormalizedCrop {
  const width = clamp(finiteOr(crop.width, MIN_CROP_EDGE), MIN_CROP_EDGE, 1);
  const height = clamp(finiteOr(crop.height, MIN_CROP_EDGE), MIN_CROP_EDGE, 1);
  return {
    x: clamp(finiteOr(crop.x, 0), 0, 1 - width),
    y: clamp(finiteOr(crop.y, 0), 0, 1 - height),
    width,
    height,
  };
}

/**
 * Convert the renderer's implicit COVER clipping into the explicit normalized
 * rectangle that is actually visible. Starting a crop session from this value
 * prevents a second hidden cover crop from being applied.
 */
export function effectiveCoverCrop(
  input: NormalizedCrop,
  sourceInput: CropSize,
  frameInput: CropSize,
): NormalizedCrop {
  const crop = clampCrop(input);
  const source = validSize(sourceInput);
  const frame = validSize(frameInput);
  const sourceCropAspect =
    (crop.width * source.width) / (crop.height * source.height);
  const frameAspect = frame.width / frame.height;

  if (sourceCropAspect > frameAspect) {
    const width = crop.height * source.height * frameAspect / source.width;
    return clampCrop({
      ...crop,
      x: crop.x + (crop.width - width) / 2,
      width,
    });
  }
  if (sourceCropAspect < frameAspect) {
    const height = crop.width * source.width / frameAspect / source.height;
    return clampCrop({
      ...crop,
      y: crop.y + (crop.height - height) / 2,
      height,
    });
  }
  return crop;
}

/**
 * Move the source image inside a fixed frame. Positive pointer movement moves
 * the source in the same direction, therefore the visible source rectangle
 * moves in the opposite direction.
 */
export function panCrop(
  input: NormalizedCrop,
  movement: CropPoint,
  context: CropRenderContext,
): NormalizedCrop {
  const source = validSize(context.source);
  const frame = validSize(context.frame);
  const crop = initialCropForSession(context.fitMode, input, source, frame);
  const cropPixels = {
    width: crop.width * source.width,
    height: crop.height * source.height,
  };
  const containScale = Math.min(
    frame.width / cropPixels.width,
    frame.height / cropPixels.height,
  );
  const rendered = context.fitMode === "COVER"
    ? frame
    : {
        width: cropPixels.width * containScale,
        height: cropPixels.height * containScale,
      };
  return clampCrop({
    ...crop,
    x: crop.x - finiteOr(movement.x, 0) / rendered.width * crop.width,
    y: crop.y - finiteOr(movement.y, 0) / rendered.height * crop.height,
  });
}

/**
 * A factor above 1 zooms in and a factor below 1 zooms out. The anchor is in
 * normalized frame coordinates, not stage coordinates, so stage zoom and
 * element rotation cannot change the crop result.
 */
export function zoomCrop(
  input: NormalizedCrop,
  factorInput: number,
  anchorInput: CropPoint = { x: 0.5, y: 0.5 },
): NormalizedCrop {
  const crop = clampCrop(input);
  const factor = Math.max(Number.EPSILON, finiteOr(factorInput, 1));
  const anchor = {
    x: clamp(finiteOr(anchorInput.x, 0.5), 0, 1),
    y: clamp(finiteOr(anchorInput.y, 0.5), 0, 1),
  };
  const minimumScale = Math.max(
    MIN_CROP_EDGE / crop.width,
    MIN_CROP_EDGE / crop.height,
  );
  const maximumScale = Math.min(1 / crop.width, 1 / crop.height);
  const scale = clamp(1 / factor, minimumScale, maximumScale);
  const width = crop.width * scale;
  const height = crop.height * scale;
  return clampCrop({
    x: crop.x + (crop.width - width) * anchor.x,
    y: crop.y + (crop.height - height) * anchor.y,
    width,
    height,
  });
}

export function initialCropForSession(
  fitMode: ImageCropFitMode,
  input: NormalizedCrop,
  source: CropSize,
  frame: CropSize,
): NormalizedCrop {
  return fitMode === "COVER"
    ? effectiveCoverCrop(input, source, frame)
    : clampCrop(input);
}

export function resetCrop(
  fitMode: ImageCropFitMode,
  source: CropSize,
  frame: CropSize,
): NormalizedCrop {
  return fitMode === "COVER"
    ? effectiveCoverCrop(FULL_CROP, source, frame)
    : { ...FULL_CROP };
}

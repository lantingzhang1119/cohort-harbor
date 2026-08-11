import path from "node:path";

export type PortalImageInput = { fileName: string; mimeType: string; bytes: Uint8Array };
export const MAX_PORTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PORTAL_IMAGE_SIDE = 16_384;
export const MAX_PORTAL_STATIC_PIXELS = 40_000_000;
export const MAX_PORTAL_ANIMATION_FRAMES = 200;
export const MAX_PORTAL_ANIMATION_COST_BYTES = 256 * 1024 * 1024;

export type PortalAssetInspection = {
  width: number;
  height: number;
  frameCount: number;
  decodedCostBytes: number;
  animated: boolean;
};

export class PortalImageError extends Error {
  constructor(
    public readonly code: "INVALID_EXTENSION" | "INVALID_MIME" | "INVALID_SIGNATURE" | "INVALID_STRUCTURE" | "FILE_TOO_LARGE" | "PIXEL_LIMIT_EXCEEDED" | "ANIMATION_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "PortalImageError";
  }
}

const ascii = (bytes: Uint8Array, start: number, end: number) => new TextDecoder("ascii").decode(bytes.slice(start, end));
const u16be = (bytes: Uint8Array, offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;
const u32be = (bytes: Uint8Array, offset: number) => ((bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
const u32le = (bytes: Uint8Array, offset: number) => (bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + (bytes[offset + 3]! * 0x1000000)) >>> 0;
const u16le = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
const u24le = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ImageFrame = { width: number; height: number };

type PngStructure = { width: number; height: number; frameCount: number; animated: boolean; frames: ImageFrame[] };

function pngStructure(bytes: Uint8Array): PngStructure | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return undefined;
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  let declaredFrames: number | undefined;
  let nextSequence = 0;
  const frames: ImageFrame[] = [];
  let activeFrameHasData = false;
  let activeFrameIndex = -1;
  let defaultImageIncluded: boolean | undefined;
  let width = 0;
  let height = 0;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) return undefined;
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) return undefined;
    if (crc32(bytes, offset + 4, dataEnd) !== u32be(bytes, dataEnd)) return undefined;
    if (chunkIndex === 0) {
      width = u32be(bytes, dataStart);
      height = u32be(bytes, dataStart + 4);
      if (type !== "IHDR" || length !== 13 || width === 0 || height === 0) return undefined;
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || ![0, 1].includes(bytes[dataStart + 12]!)) return undefined;
    }
    if (type === "acTL") {
      if (length !== 8 || declaredFrames !== undefined || sawIdat) return undefined;
      declaredFrames = u32be(bytes, dataStart);
      if (declaredFrames === 0) return undefined;
    } else if (type === "fcTL") {
      if (declaredFrames === undefined || length !== 26 || u32be(bytes, dataStart) !== nextSequence || (activeFrameIndex >= 0 && !activeFrameHasData)) return undefined;
      nextSequence += 1;
      const frameWidth = u32be(bytes, dataStart + 4);
      const frameHeight = u32be(bytes, dataStart + 8);
      const xOffset = u32be(bytes, dataStart + 12);
      const yOffset = u32be(bytes, dataStart + 16);
      const dispose = bytes[dataStart + 24]!;
      const blend = bytes[dataStart + 25]!;
      if (frameWidth === 0 || frameHeight === 0 || xOffset + frameWidth > width || yOffset + frameHeight > height || dispose > 2 || blend > 1) return undefined;
      if (!sawIdat) {
        if (frames.length !== 0 || frameWidth !== width || frameHeight !== height || xOffset !== 0 || yOffset !== 0) return undefined;
        defaultImageIncluded = true;
      } else if (defaultImageIncluded === undefined) return undefined;
      frames.push({ width: frameWidth, height: frameHeight });
      activeFrameIndex = frames.length - 1;
      activeFrameHasData = false;
    } else if (type === "IDAT") {
      if (declaredFrames !== undefined) {
        if (!sawIdat) {
          if (activeFrameIndex === -1) defaultImageIncluded = false;
          else if (activeFrameIndex !== 0 || defaultImageIncluded !== true) return undefined;
        }
        if (defaultImageIncluded === true) {
          if (activeFrameIndex !== 0) return undefined;
          activeFrameHasData = true;
        } else if (activeFrameIndex !== -1) return undefined;
      }
      sawIdat = true;
    } else if (type === "fdAT") {
      const minimumFrameIndex = defaultImageIncluded ? 1 : 0;
      if (declaredFrames === undefined || !sawIdat || defaultImageIncluded === undefined || length < 5 || activeFrameIndex < minimumFrameIndex || u32be(bytes, dataStart) !== nextSequence) return undefined;
      nextSequence += 1;
      activeFrameHasData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || chunkEnd !== bytes.byteLength) return undefined;
      if (declaredFrames !== undefined && (frames.length !== declaredFrames || !activeFrameHasData)) return undefined;
      return { width, height, frameCount: declaredFrames ?? 1, animated: declaredFrames !== undefined, frames: declaredFrames === undefined ? [{ width, height }] : frames };
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return undefined;
}

function validPng(bytes: Uint8Array) {
  return pngStructure(bytes) !== undefined;
}

function validJpeg(bytes: Uint8Array) {
  if (bytes.byteLength < 6 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.byteLength;
    if (marker === 0xd8 || marker === 0x00) return false;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) return false;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const precision = bytes[offset + 2]!;
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      const components = bytes[offset + 7]!;
      if (precision === 0 || width === 0 || height === 0 || components === 0 || length !== 8 + 3 * components) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      sawScan = true;
      offset += length;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        if (offset + 1 >= bytes.byteLength) return false;
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      continue;
    }
    offset += length;
  }
  return false;
}

function validWebp(bytes: Uint8Array) {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return false;
  if (u32le(bytes, 4) !== bytes.byteLength - 8) return false;
  let offset = 12;
  let canvas: ImageFrame | undefined;
  let animationFlag = false;
  let sawAnim = false;
  let topLevelImage: ImageFrame | undefined;
  let animationFrames = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const type = ascii(bytes, offset, offset + 4);
    const length = u32le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length % 2);
    if (dataEnd < dataStart || paddedEnd > bytes.byteLength) return false;
    if (length % 2 === 1 && bytes[dataEnd] !== 0) return false;
    if (type === "VP8L" || type === "VP8 ") {
      const dimensions = webpImageDimensions(type, bytes, dataStart, length);
      if (!dimensions || topLevelImage || animationFrames > 0) return false;
      topLevelImage = dimensions;
    } else if (type === "VP8X") {
      if (length !== 10 || canvas || topLevelImage || sawAnim || animationFrames > 0 || offset !== 12) return false;
      canvas = { width: u24le(bytes, dataStart + 4) + 1, height: u24le(bytes, dataStart + 7) + 1 };
      animationFlag = (bytes[dataStart]! & 0x02) !== 0;
    } else if (type === "ANIM") {
      if (!canvas || !animationFlag || sawAnim || topLevelImage || animationFrames > 0 || length !== 6) return false;
      sawAnim = true;
    } else if (type === "ANMF") {
      if (!canvas || !animationFlag || !sawAnim || topLevelImage || length < 16) return false;
      const frameX = u24le(bytes, dataStart) * 2;
      const frameY = u24le(bytes, dataStart + 3) * 2;
      const frameWidth = u24le(bytes, dataStart + 6) + 1;
      const frameHeight = u24le(bytes, dataStart + 9) + 1;
      if (frameX + frameWidth > canvas.width || frameY + frameHeight > canvas.height) return false;
      let frameOffset = dataStart + 16;
      let sawFrameImage = false;
      while (frameOffset < dataEnd) {
        if (frameOffset + 8 > dataEnd) return false;
        const frameType = ascii(bytes, frameOffset, frameOffset + 4);
        const frameLength = u32le(bytes, frameOffset + 4);
        const frameData = frameOffset + 8;
        const frameEnd = frameData + frameLength;
        if (frameEnd < frameData || frameEnd > dataEnd) return false;
        if (frameType === "VP8L" || frameType === "VP8 ") {
          const dimensions = webpImageDimensions(frameType, bytes, frameData, frameLength);
          if (sawFrameImage || !dimensions || dimensions.width !== frameWidth || dimensions.height !== frameHeight) return false;
          sawFrameImage = true;
        }
        frameOffset = frameEnd + (frameLength % 2);
      }
      if (!sawFrameImage || frameOffset !== dataEnd) return false;
      animationFrames += 1;
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.byteLength) return false;
  if (animationFlag) return sawAnim && animationFrames > 0 && !topLevelImage;
  if (sawAnim || animationFrames > 0 || !topLevelImage) return false;
  return !canvas || (canvas.width === topLevelImage.width && canvas.height === topLevelImage.height);
}

function webpImageDimensions(type: "VP8L" | "VP8 ", bytes: Uint8Array, dataStart: number, length: number): ImageFrame | undefined {
  if (type === "VP8L") {
    if (length < 5 || bytes[dataStart] !== 0x2f || (bytes[dataStart + 4]! >>> 5) !== 0) return undefined;
    const dimensions = webpVp8lDimensions(bytes, dataStart);
    return dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
  }
  if (length < 10 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) return undefined;
  const dimensions = webpVp8Dimensions(bytes, dataStart);
  return dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number) {
  let offset = start;
  while (offset < bytes.byteLength) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    if (offset + length > bytes.byteLength) return -1;
    offset += length;
  }
  return -1;
}

function validGif(bytes: Uint8Array) {
  if (bytes.byteLength < 14 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return false;
  const canvasWidth = u16le(bytes, 6);
  const canvasHeight = u16le(bytes, 8);
  if (canvasWidth === 0 || canvasHeight === 0) return false;
  let offset = 13;
  if ((bytes[10]! & 0x80) !== 0) offset += 3 * (2 ** ((bytes[10]! & 0x07) + 1));
  if (offset > bytes.byteLength) return false;
  let sawImage = false;
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset++]!;
    if (introducer === 0x3b) return sawImage && offset === bytes.byteLength;
    if (introducer === 0x21) {
      if (offset >= bytes.byteLength) return false;
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return false;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.byteLength) return false;
    const left = u16le(bytes, offset);
    const top = u16le(bytes, offset + 2);
    const width = u16le(bytes, offset + 4);
    const height = u16le(bytes, offset + 6);
    if (width === 0 || height === 0 || left + width > canvasWidth || top + height > canvasHeight) return false;
    const packed = bytes[offset + 8]!;
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset >= bytes.byteLength) return false;
    const minimumCodeSize = bytes[offset++]!;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
    offset = skipGifSubBlocks(bytes, offset);
    if (offset < 0) return false;
    sawImage = true;
  }
  return false;
}

const formats = {
  ".png": { mime: "image/png", signature: (bytes: Uint8Array) => bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG", structure: validPng },
  ".jpg": { mime: "image/jpeg", signature: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, structure: validJpeg },
  ".jpeg": { mime: "image/jpeg", signature: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, structure: validJpeg },
  ".webp": { mime: "image/webp", signature: (bytes: Uint8Array) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP", structure: validWebp },
  ".gif": { mime: "image/gif", signature: (bytes: Uint8Array) => ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)), structure: validGif },
} as const;

export function validatePortalImage(file: PortalImageInput, maxBytes = MAX_PORTAL_IMAGE_BYTES) {
  const extension = path.extname(file.fileName).toLowerCase() as keyof typeof formats;
  const format = formats[extension];
  if (!format) throw new PortalImageError("INVALID_EXTENSION", "门户素材仅支持 PNG、JPEG、WebP 或 GIF");
  if (file.mimeType !== format.mime) throw new PortalImageError("INVALID_MIME", "门户素材 MIME 类型与扩展名不一致");
  if (file.bytes.byteLength > maxBytes) throw new PortalImageError("FILE_TOO_LARGE", "门户素材超过 10 MiB 限制");
  if (!format.signature(file.bytes)) throw new PortalImageError("INVALID_SIGNATURE", "门户素材文件签名无效");
  if (!format.structure(file.bytes)) throw new PortalImageError("INVALID_STRUCTURE", "图片文件结构无效或不受支持，请重新导出为 PNG、JPG、WebP 或 GIF 后上传");
}

function pngInspection(bytes: Uint8Array): PortalAssetInspection {
  const parsed = pngStructure(bytes);
  if (!parsed) throw new PortalImageError("INVALID_STRUCTURE", "图片文件结构无效");
  return inspection(parsed.width, parsed.height, parsed.frameCount, parsed.animated, parsed.frames);
}

function jpegInspection(bytes: Uint8Array): PortalAssetInspection {
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = u16be(bytes, offset);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return inspection(u16be(bytes, offset + 5), u16be(bytes, offset + 3), 1, false, [{ width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3) }]);
    }
    offset += length;
  }
  throw new PortalImageError("INVALID_STRUCTURE", "图片文件缺少可读取的尺寸信息");
}

function webpVp8lDimensions(bytes: Uint8Array, offset: number) {
  return {
    width: 1 + bytes[offset + 1]! + ((bytes[offset + 2]! & 0x3f) << 8),
    height: 1 + (bytes[offset + 2]! >>> 6) + (bytes[offset + 3]! << 2) + ((bytes[offset + 4]! & 0x0f) << 10),
  };
}

function webpVp8Dimensions(bytes: Uint8Array, offset: number) {
  return {
    width: u16le(bytes, offset + 6) & 0x3fff,
    height: u16le(bytes, offset + 8) & 0x3fff,
  };
}

function webpInspection(bytes: Uint8Array): PortalAssetInspection {
  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  const frames: Array<{ width: number; height: number }> = [];
  let animated = false;
  while (offset < bytes.byteLength) {
    const type = ascii(bytes, offset, offset + 4);
    const length = u32le(bytes, offset + 4);
    const dataStart = offset + 8;
    if (type === "VP8X") canvas = { width: u24le(bytes, dataStart + 4) + 1, height: u24le(bytes, dataStart + 7) + 1 };
    if (type === "VP8L") frames.push(webpVp8lDimensions(bytes, dataStart));
    if (type === "VP8 ") frames.push(webpVp8Dimensions(bytes, dataStart));
    if (type === "ANMF") {
      animated = true;
      frames.push({ width: u24le(bytes, dataStart + 6) + 1, height: u24le(bytes, dataStart + 9) + 1 });
    }
    offset = dataStart + length + (length % 2);
  }
  const dimensions = canvas ?? frames[0];
  if (!dimensions || frames.length === 0) throw new PortalImageError("INVALID_STRUCTURE", "图片文件缺少可读取的尺寸信息");
  return inspection(dimensions.width, dimensions.height, frames.length, animated, frames);
}

function gifInspection(bytes: Uint8Array): PortalAssetInspection {
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  let offset = 13 + ((bytes[10]! & 0x80) === 0 ? 0 : 3 * (2 ** ((bytes[10]! & 0x07) + 1)));
  const frames: Array<{ width: number; height: number }> = [];
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset++]!;
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (introducer !== 0x2c) break;
    frames.push({ width: u16le(bytes, offset + 4), height: u16le(bytes, offset + 6) });
    const packed = bytes[offset + 8]!;
    offset += 9 + ((packed & 0x80) === 0 ? 0 : 3 * (2 ** ((packed & 0x07) + 1)));
    offset += 1;
    offset = skipGifSubBlocks(bytes, offset);
  }
  const animated = frames.length > 1;
  return inspection(width, height, frames.length, animated, animated ? frames : undefined);
}

function inspection(width: number, height: number, frameCount: number, animated: boolean, frames?: Array<{ width: number; height: number }>): PortalAssetInspection {
  for (const frame of frames ?? []) {
    if (frame.width > MAX_PORTAL_IMAGE_SIDE || frame.height > MAX_PORTAL_IMAGE_SIDE) {
      throw new PortalImageError("PIXEL_LIMIT_EXCEEDED", "门户素材单边不能超过 16,384 像素");
    }
  }
  if (width > MAX_PORTAL_IMAGE_SIDE || height > MAX_PORTAL_IMAGE_SIDE) {
    throw new PortalImageError("PIXEL_LIMIT_EXCEEDED", "门户素材单边不能超过 16,384 像素");
  }
  const decodedWidth = animated ? width : (frames?.[0]?.width ?? width);
  const decodedHeight = animated ? height : (frames?.[0]?.height ?? height);
  if (!animated && decodedWidth * decodedHeight > MAX_PORTAL_STATIC_PIXELS) {
    throw new PortalImageError("PIXEL_LIMIT_EXCEEDED", "门户静态素材不能超过 40,000,000 像素");
  }
  if (animated && frameCount > MAX_PORTAL_ANIMATION_FRAMES) {
    throw new PortalImageError("ANIMATION_LIMIT_EXCEEDED", "门户动画帧数或解码成本超过限制");
  }
  const decodedCostBytes = animated
    ? width * height * 4 * frameCount
    : decodedWidth * decodedHeight * 4;
  if (animated && decodedCostBytes > MAX_PORTAL_ANIMATION_COST_BYTES) {
    throw new PortalImageError("ANIMATION_LIMIT_EXCEEDED", "门户动画帧数或解码成本超过限制");
  }
  return { width, height, frameCount, decodedCostBytes, animated };
}

export function inspectPortalImage(file: PortalImageInput): PortalAssetInspection {
  validatePortalImage(file);
  const extension = path.extname(file.fileName).toLowerCase();
  switch (extension) {
    case ".png": return pngInspection(file.bytes);
    case ".jpg":
    case ".jpeg": return jpegInspection(file.bytes);
    case ".webp": return webpInspection(file.bytes);
    case ".gif": return gifInspection(file.bytes);
    default: throw new PortalImageError("INVALID_EXTENSION", "门户素材仅支持 PNG、JPEG、WebP 或 GIF");
  }
}

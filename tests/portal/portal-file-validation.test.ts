import { describe, expect, it } from "vitest";

import { inspectPortalImage, MAX_PORTAL_IMAGE_BYTES, PortalImageError, validatePortalImage } from "@/features/portal/portal-file-validation";
import { validGif, validJpeg, validPng, validWebp } from "../fixtures/portal-images";

function pngWithDimensions(width: number, height: number) {
  const bytes = validPng();
  bytes.set([width >>> 24, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  bytes.set([height >>> 24, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
  const chunk = bytes.slice(12, 29);
  let crc = 0xffffffff;
  for (const byte of chunk) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  bytes.set([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 29);
  return bytes;
}

function oversizedPng() {
  return pngWithDimensions(16_385, 1);
}

function pngWithZeroFrameAnimationControl() {
  const png = pngWithDimensions(10_000, 5_000);
  const control = new Uint8Array(20);
  control.set([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c], 0);
  const chunk = control.slice(4, 16);
  let crc = 0xffffffff;
  for (const byte of chunk) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  control.set([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 16);
  const result = new Uint8Array(png.byteLength + control.byteLength);
  result.set(png.slice(0, 33));
  result.set(control, 33);
  result.set(png.slice(33), 33 + control.byteLength);
  return result;
}

function frameBombGif(frameCount = 201, logicalWidth = 1, logicalHeight = 1) {
  const frame = validGif().slice(13 + 6, -1);
  const header = validGif().slice(0, 13 + 6);
  const bytes = new Uint8Array(header.byteLength + frame.byteLength * frameCount + 1);
  bytes.set(header);
  bytes.set([logicalWidth & 0xff, logicalWidth >>> 8, logicalHeight & 0xff, logicalHeight >>> 8], 6);
  for (let index = 0; index < frameCount; index += 1) bytes.set(frame, header.byteLength + frame.byteLength * index);
  bytes[bytes.byteLength - 1] = 0x3b;
  return bytes;
}

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function u32be(value: number) {
  return new Uint8Array([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32le(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]);
}

function u24le(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, value >>> 16]);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const tagged = concat(new TextEncoder().encode(type), data);
  return concat(u32be(data.byteLength), tagged, u32be(crc32(tagged)));
}

function apngFrameControl(sequence: number, width = 1, height = 1, xOffset = 0, yOffset = 0, dispose = 0, blend = 0) {
  return pngChunk("fcTL", concat(u32be(sequence), u32be(width), u32be(height), u32be(xOffset), u32be(yOffset), new Uint8Array([0, 1, 0, 1, dispose, blend])));
}

function validApng() {
  const png = validPng();
  const idat = png.slice(33, -12);
  return concat(
    png.slice(0, 33),
    pngChunk("acTL", concat(u32be(2), u32be(0))),
    apngFrameControl(0),
    idat,
    idat,
    apngFrameControl(1),
    pngChunk("fdAT", concat(u32be(2), new Uint8Array([0x78]))),
    pngChunk("fdAT", concat(u32be(3), new Uint8Array([0x9c]))),
    png.slice(-12),
  );
}

function excludedDefaultImageApng() {
  const png = validPng();
  return concat(
    png.slice(0, 33),
    pngChunk("acTL", concat(u32be(1), u32be(0))),
    png.slice(33, -12),
    apngFrameControl(0),
    pngChunk("fdAT", concat(u32be(1), new Uint8Array([0x78]))),
    png.slice(-12),
  );
}

function includedDefaultImageApng(width: number, height: number, frameCount: number) {
  const png = pngWithDimensions(width, height);
  const chunks = [png.slice(0, 33), pngChunk("acTL", concat(u32be(frameCount), u32be(0))), apngFrameControl(0, width, height), png.slice(33, -12)];
  let sequence = 1;
  for (let frame = 1; frame < frameCount; frame += 1) {
    chunks.push(apngFrameControl(sequence, width, height));
    sequence += 1;
    chunks.push(pngChunk("fdAT", concat(u32be(sequence), new Uint8Array([0x78]))));
    sequence += 1;
  }
  chunks.push(png.slice(-12));
  return concat(...chunks);
}

function invalidIncludedDefaultControl(kind: "offset" | "dispose" | "blend") {
  const png = pngWithDimensions(2, 2);
  const control = kind === "offset"
    ? apngFrameControl(0, 1, 1, 1)
    : apngFrameControl(0, 2, 2, 0, 0, kind === "dispose" ? 3 : 0, kind === "blend" ? 2 : 0);
  return concat(png.slice(0, 33), pngChunk("acTL", concat(u32be(1), u32be(0))), control, png.slice(33));
}

function invalidApngControlAfterImageData() {
  const png = pngWithDimensions(10_000, 5_000);
  return concat(png.slice(0, -12), pngChunk("acTL", concat(u32be(1), u32be(0))), apngFrameControl(0, 10_000, 5_000), png.slice(-12));
}

function outOfBoundsGif() {
  const bytes = validGif();
  bytes.set([0, 0, 0, 0, 0x10, 0x27, 0x50, 0xc3], 20);
  return bytes;
}

function riffChunk(type: string, data: Uint8Array) {
  const padding = data.byteLength % 2 === 1 ? new Uint8Array([0]) : new Uint8Array();
  return concat(new TextEncoder().encode(type), u32le(data.byteLength), data, padding);
}

function webp(chunks: Uint8Array[]) {
  const payload = concat(new TextEncoder().encode("WEBP"), ...chunks);
  return concat(new TextEncoder().encode("RIFF"), u32le(payload.byteLength), payload);
}

function vp8l(width = 1, height = 1) {
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  return riffChunk("VP8L", new Uint8Array([
    0x2f,
    encodedWidth & 0xff,
    ((encodedWidth >>> 8) & 0x3f) | ((encodedHeight & 0x03) << 6),
    (encodedHeight >>> 2) & 0xff,
    (encodedHeight >>> 10) & 0x0f,
  ]));
}

function animatedWebp() {
  const vp8x = riffChunk("VP8X", new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const anim = riffChunk("ANIM", new Uint8Array([0, 0, 0, 0, 0, 0]));
  const frame = concat(u24le(0), u24le(0), u24le(0), u24le(0), u24le(0), new Uint8Array([0]), vp8l());
  return webp([vp8x, anim, riffChunk("ANMF", frame), riffChunk("ANMF", frame)]);
}

function mismatchedAnimatedWebp() {
  const vp8x = riffChunk("VP8X", new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const anim = riffChunk("ANIM", new Uint8Array([0, 0, 0, 0, 0, 0]));
  const frame = concat(u24le(0), u24le(0), u24le(0), u24le(0), u24le(0), new Uint8Array([0]), vp8l(10_000, 5_000));
  return webp([vp8x, anim, riffChunk("ANMF", frame)]);
}

function zeroDimensionJpeg() {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 4, 0x4a, 0x46,
    0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0,
    0x00,
    0xff, 0xd9,
  ]);
}

describe("portal image validation", () => {
  it.each([
    ["PNG", "image.png", "image/png", validPng(), { width: 1, height: 1, frameCount: 1, decodedCostBytes: 4, animated: false }],
    ["JPEG", "image.jpg", "image/jpeg", validJpeg(), { width: 1, height: 1, frameCount: 1, decodedCostBytes: 4, animated: false }],
    ["WebP", "image.webp", "image/webp", validWebp(), { width: 1, height: 1, frameCount: 1, decodedCostBytes: 4, animated: false }],
    ["GIF", "image.gif", "image/gif", validGif(), { width: 1, height: 1, frameCount: 1, decodedCostBytes: 4, animated: false }],
    ["APNG with default image included", "image.png", "image/png", validApng(), { width: 1, height: 1, frameCount: 2, decodedCostBytes: 8, animated: true }],
    ["APNG with default image excluded", "image.png", "image/png", excludedDefaultImageApng(), { width: 1, height: 1, frameCount: 1, decodedCostBytes: 4, animated: true }],
    ["animated WebP", "image.webp", "image/webp", animatedWebp(), { width: 1, height: 1, frameCount: 2, decodedCostBytes: 8, animated: true }],
  ])("returns decoded metadata for valid %s", (_format, fileName, mimeType, bytes, expected) => {
    expect(inspectPortalImage({ fileName, mimeType, bytes })).toEqual(expected);
  });

  it("rejects invalid APNG order, GIF frame bounds, WebP container semantics, and incomplete JPEG SOF headers", () => {
    expect(() => inspectPortalImage({ fileName: "late-control.png", mimeType: "image/png", bytes: invalidApngControlAfterImageData() })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
    expect(() => inspectPortalImage({ fileName: "outside.gif", mimeType: "image/gif", bytes: outOfBoundsGif() })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
    expect(() => inspectPortalImage({ fileName: "repeated.webp", mimeType: "image/webp", bytes: webp([vp8l(), vp8l()]) })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
    expect(() => inspectPortalImage({ fileName: "zero.webp", mimeType: "image/webp", bytes: webp([riffChunk("VP8 ", new Uint8Array([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]))]) })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
    expect(() => inspectPortalImage({ fileName: "zero-components.jpg", mimeType: "image/jpeg", bytes: zeroDimensionJpeg() })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
  });

  it("requires included APNG default controls to cover the canvas and use valid operations", () => {
    for (const kind of ["offset", "dispose", "blend"] as const) {
      expect(() => inspectPortalImage({ fileName: `${kind}.png`, mimeType: "image/png", bytes: invalidIncludedDefaultControl(kind) })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
    }
  });

  it("accepts exactly 256 MiB decoded animation cost and rejects the nearest practical overage", () => {
    expect(inspectPortalImage({ fileName: "exact-cost.png", mimeType: "image/png", bytes: includedDefaultImageApng(4_096, 4_096, 4) })).toMatchObject({ decodedCostBytes: 268_435_456, frameCount: 4, animated: true });
    expect(() => inspectPortalImage({ fileName: "over-cost.png", mimeType: "image/png", bytes: includedDefaultImageApng(4_097, 4_096, 4) })).toThrowError(expect.objectContaining({ code: "ANIMATION_LIMIT_EXCEEDED" }));
  });

  it("accepts exact side, static-pixel, and animation-frame boundaries before calculating cost", () => {
    expect(inspectPortalImage({ fileName: "side.png", mimeType: "image/png", bytes: pngWithDimensions(16_384, 1) })).toMatchObject({ width: 16_384, height: 1, frameCount: 1, decodedCostBytes: 65_536, animated: false });
    expect(inspectPortalImage({ fileName: "pixels.png", mimeType: "image/png", bytes: pngWithDimensions(8_000, 5_000) })).toMatchObject({ width: 8_000, height: 5_000, frameCount: 1, decodedCostBytes: 160_000_000, animated: false });
    expect(inspectPortalImage({ fileName: "frames.gif", mimeType: "image/gif", bytes: frameBombGif(200) })).toMatchObject({ width: 1, height: 1, frameCount: 200, decodedCostBytes: 800, animated: true });
  });
  it("rejects excessive dimensions and animation cost", () => {
    expect(() => inspectPortalImage({ fileName: "oversized.png", mimeType: "image/png", bytes: oversizedPng() })).toThrowError(
      expect.objectContaining({ code: "PIXEL_LIMIT_EXCEEDED" }),
    );
    expect(() => inspectPortalImage({ fileName: "frame-bomb.gif", mimeType: "image/gif", bytes: frameBombGif() })).toThrowError(
      expect.objectContaining({ code: "ANIMATION_LIMIT_EXCEEDED" }),
    );
  });

  it("counts each GIF animation frame as its full logical canvas", () => {
    expect(() => inspectPortalImage({ fileName: "canvas-bomb.gif", mimeType: "image/gif", bytes: frameBombGif(2, 12_000, 12_000) })).toThrowError(
      expect.objectContaining({ code: "ANIMATION_LIMIT_EXCEEDED" }),
    );
  });

  it("costs a static GIF as its decoded logical canvas", () => {
    expect(() => inspectPortalImage({ fileName: "large-static-canvas.gif", mimeType: "image/gif", bytes: frameBombGif(1, 10_000, 5_000) })).toThrowError(
      expect.objectContaining({ code: "PIXEL_LIMIT_EXCEEDED" }),
    );
  });

  it("rejects animated WebP bitstreams that disagree with their ANMF rectangle", () => {
    expect(() => inspectPortalImage({ fileName: "mismatched.webp", mimeType: "image/webp", bytes: mismatchedAnimatedWebp() })).toThrowError(
      expect.objectContaining({ code: "INVALID_STRUCTURE" }),
    );
  });

  it("does not let a zero-frame APNG control bypass static pixel limits", () => {
    expect(() => inspectPortalImage({ fileName: "fake-animation.png", mimeType: "image/png", bytes: pngWithZeroFrameAnimationControl() })).toThrowError(
      expect.objectContaining({ code: "INVALID_STRUCTURE" }),
    );
  });

  it.each([
    ["hero.png", "image/png", validPng()],
    ["photo.jpg", "image/jpeg", validJpeg()],
    ["photo.jpeg", "image/jpeg", validJpeg()],
    ["brand.webp", "image/webp", validWebp()],
    ["motion.gif", "image/gif", validGif("87a")],
    ["motion.GIF", "image/gif", validGif("89a")],
  ])("accepts a complete structurally valid %s", (fileName, mimeType, bytes) => {
    expect(() => validatePortalImage({ fileName, mimeType, bytes })).not.toThrow();
  });

  it("accepts an exactly 10 MiB structurally valid PNG and rejects 10 MiB plus one", () => {
    const exact = validPng(MAX_PORTAL_IMAGE_BYTES);
    const tooLarge = validPng(MAX_PORTAL_IMAGE_BYTES + 1);
    expect(exact.byteLength).toBe(MAX_PORTAL_IMAGE_BYTES);
    expect(() => validatePortalImage({ fileName: "exact.png", mimeType: "image/png", bytes: exact })).not.toThrow();
    expect(() => validatePortalImage({ fileName: "large.png", mimeType: "image/png", bytes: tooLarge })).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
  }, 15_000);

  it.each([
    ["PNG truncation", "broken.png", "image/png", validPng().slice(0, -1)],
    ["PNG trailing bytes", "trailing.png", "image/png", new Uint8Array([...validPng(), 0])],
    ["JPEG truncation", "broken.jpg", "image/jpeg", validJpeg().slice(0, -2)],
    ["JPEG trailing bytes", "trailing.jpg", "image/jpeg", new Uint8Array([...validJpeg(), 0])],
    ["WebP wrong RIFF length", "broken.webp", "image/webp", new Uint8Array([...validWebp().slice(0, 4), 0, 0, 0, 0, ...validWebp().slice(8)])],
    ["WebP trailing bytes", "trailing.webp", "image/webp", new Uint8Array([...validWebp(), 0])],
    ["GIF missing trailer", "broken.gif", "image/gif", validGif().slice(0, -1)],
    ["GIF trailing bytes", "trailing.gif", "image/gif", new Uint8Array([...validGif(), 0])],
  ])("rejects %s", (_case, fileName, mimeType, bytes) => {
    expect(() => validatePortalImage({ fileName, mimeType, bytes })).toThrowError(expect.objectContaining({ code: "INVALID_STRUCTURE" }));
  });

  it("rejects active/document payloads appended beyond the former 64 KiB scan window", () => {
    const valid = validPng();
    const padding = new Uint8Array(70 * 1024);
    const payload = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const appended = new Uint8Array(valid.byteLength + padding.byteLength + payload.byteLength);
    appended.set(valid); appended.set(padding, valid.byteLength); appended.set(payload, valid.byteLength + padding.byteLength);
    expect(() => validatePortalImage({ fileName: "late-polyglot.png", mimeType: "image/png", bytes: appended })).toThrow(PortalImageError);
  });

  it.each([
    ["vector.svg", "image/svg+xml", new TextEncoder().encode("<svg><script/></svg>")],
    ["page.html", "text/html", new TextEncoder().encode("<!doctype html><html></html>")],
    ["clip.mp4", "video/mp4", new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])],
    ["brief.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7")],
    ["fake.jpg", "image/jpeg", validPng()],
    ["fake.png", "image/jpeg", validPng()],
  ])("rejects unsafe or mismatched file %s", (fileName, mimeType, bytes) => {
    expect(() => validatePortalImage({ fileName, mimeType, bytes })).toThrow(PortalImageError);
  });
});

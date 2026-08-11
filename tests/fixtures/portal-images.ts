function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function u32be(value: number) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32le(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
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
  const typeBytes = new TextEncoder().encode(type);
  return concat(u32be(data.byteLength), typeBytes, data, u32be(crc32(concat(typeBytes, data))));
}

export function validPng(totalBytes?: number) {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1]));
  const iend = pngChunk("IEND", new Uint8Array());
  if (totalBytes === undefined) return concat(signature, ihdr, idat, iend);
  const payloadLength = totalBytes - signature.byteLength - ihdr.byteLength - idat.byteLength - iend.byteLength - 12;
  if (payloadLength < 2) throw new Error("requested PNG size is too small");
  const text = new Uint8Array(payloadLength);
  text[0] = 0x78;
  return concat(signature, ihdr, pngChunk("tEXt", text), idat, iend);
}

export function validJpeg() {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 4, 0x4a, 0x46,
    0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0,
    0x00,
    0xff, 0xd9,
  ]);
}

export function validWebp() {
  const payload = new Uint8Array([0x2f, 0, 0, 0, 0]);
  const chunk = concat(new TextEncoder().encode("VP8L"), u32le(payload.byteLength), payload, new Uint8Array([0]));
  return concat(new TextEncoder().encode("RIFF"), u32le(4 + chunk.byteLength), new TextEncoder().encode("WEBP"), chunk);
}

export function validGif(version: "87a" | "89a" = "89a") {
  return concat(
    new TextEncoder().encode(`GIF${version}`),
    new Uint8Array([1, 0, 1, 0, 0x80, 0, 0]),
    new Uint8Array([0, 0, 0, 0xff, 0xff, 0xff]),
    new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]),
  );
}

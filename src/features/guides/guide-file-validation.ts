import path from "node:path";

export type GuideImageInput = { fileName: string; mimeType: string; bytes: Uint8Array };

export class GuideImageError extends Error {
  constructor(
    public readonly code: "INVALID_EXTENSION" | "INVALID_MIME" | "INVALID_SIGNATURE" | "FILE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "GuideImageError";
  }
}

const formats = {
  ".png": { mime: "image/png", matches: (bytes: Uint8Array) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value) },
  ".jpg": { mime: "image/jpeg", matches: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  ".jpeg": { mime: "image/jpeg", matches: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  ".webp": { mime: "image/webp", matches: (bytes: Uint8Array) => new TextDecoder("ascii").decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder("ascii").decode(bytes.slice(8, 12)) === "WEBP" },
  ".gif": { mime: "image/gif", matches: (bytes: Uint8Array) => ["GIF87a", "GIF89a"].includes(new TextDecoder("ascii").decode(bytes.slice(0, 6))) },
} as const;

export function validateGuideImage(file: GuideImageInput, maxBytes = 10 * 1024 * 1024) {
  const extension = path.extname(file.fileName).toLowerCase() as keyof typeof formats;
  const format = formats[extension];
  if (!format) throw new GuideImageError("INVALID_EXTENSION", "指南图片仅支持 PNG、JPEG、WebP 或 GIF");
  if (file.mimeType !== format.mime) throw new GuideImageError("INVALID_MIME", "指南图片 MIME 类型与扩展名不一致");
  if (file.bytes.byteLength > maxBytes) throw new GuideImageError("FILE_TOO_LARGE", "指南图片超过 10 MB 限制");
  if (!format.matches(file.bytes)) throw new GuideImageError("INVALID_SIGNATURE", "指南图片文件签名无效");
}

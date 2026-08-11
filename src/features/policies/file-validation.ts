import path from "node:path";

export type PolicyFileInput = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export class PolicyFileError extends Error {
  constructor(
    public readonly code:
      | "INVALID_EXTENSION"
      | "INVALID_MIME"
      | "INVALID_SIGNATURE"
      | "FILE_TOO_LARGE"
      | "UNSUPPORTED_FORMAT",
    message: string,
  ) {
    super(message);
    this.name = "PolicyFileError";
  }
}

export type PolicyPreviewStrategy = "PDF" | "OFFICE" | "IMAGE" | "CSV" | "TEXT";

type FormatRule = {
  mimeTypes: readonly string[];
  strategy: PolicyPreviewStrategy;
  signature: (bytes: Uint8Array) => boolean;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((value, index) => bytes[index] === value);
const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder("ascii").decode(bytes.slice(start, end));
const isText = (bytes: Uint8Array) => !bytes.slice(0, 8192).includes(0);
const isZip = (bytes: Uint8Array) =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
  startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
const isOle = (bytes: Uint8Array) => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const formatRules: Record<string, FormatRule> = {
  ".pdf": { mimeTypes: ["application/pdf"], strategy: "PDF", signature: (bytes) => ascii(bytes, 0, 5) === "%PDF-" },
  ".doc": { mimeTypes: ["application/msword"], strategy: "OFFICE", signature: isOle },
  ".docx": { mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], strategy: "OFFICE", signature: isZip },
  ".xls": { mimeTypes: ["application/vnd.ms-excel"], strategy: "OFFICE", signature: isOle },
  ".xlsx": { mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], strategy: "OFFICE", signature: isZip },
  ".ppt": { mimeTypes: ["application/vnd.ms-powerpoint"], strategy: "OFFICE", signature: isOle },
  ".pptx": { mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], strategy: "OFFICE", signature: isZip },
  ".png": { mimeTypes: ["image/png"], strategy: "IMAGE", signature: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ".jpg": { mimeTypes: ["image/jpeg"], strategy: "IMAGE", signature: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  ".jpeg": { mimeTypes: ["image/jpeg"], strategy: "IMAGE", signature: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  ".gif": { mimeTypes: ["image/gif"], strategy: "IMAGE", signature: (bytes) => ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) },
  ".webp": { mimeTypes: ["image/webp"], strategy: "IMAGE", signature: (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" },
  ".csv": { mimeTypes: ["text/csv"], strategy: "CSV", signature: isText },
  ".txt": { mimeTypes: ["text/plain"], strategy: "TEXT", signature: isText },
};

export function validatePolicyFile(file: PolicyFileInput, maxBytes = 50 * 1024 * 1024) {
  const extension = path.extname(file.fileName).toLowerCase();
  const rule = formatRules[extension];
  if (!rule) {
    throw new PolicyFileError("UNSUPPORTED_FORMAT", "不支持该制度文件格式");
  }
  if (file.bytes.byteLength > maxBytes) {
    throw new PolicyFileError("FILE_TOO_LARGE", "制度文件超过允许大小");
  }
  if (!rule.mimeTypes.includes(file.mimeType.toLowerCase())) {
    throw new PolicyFileError("INVALID_MIME", "制度文件扩展名与 MIME 类型不一致");
  }
  if (!rule.signature(file.bytes)) {
    throw new PolicyFileError("INVALID_SIGNATURE", "制度文件内容与声明格式不一致");
  }
  return { extension, mimeType: rule.mimeTypes[0], strategy: rule.strategy };
}

export function validatePolicyPdf(file: PolicyFileInput, maxBytes = 30 * 1024 * 1024) {
  const descriptor = validatePolicyFile(file, maxBytes);
  if (descriptor.strategy !== "PDF") {
    throw new PolicyFileError("INVALID_EXTENSION", "制度文件必须使用 .pdf 扩展名");
  }
  return descriptor;
}

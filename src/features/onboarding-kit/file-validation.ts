import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { UploadFileLike, UploadLimits, ValidatedUpload } from "@/features/onboarding-kit/file-types";
import { validatePortalImage } from "@/features/portal/portal-file-validation";
import { PrivateUploadValidationError, stagePrivateUpload } from "@/lib/storage/private-upload-validation";

export type OnboardingUploadErrorCode =
  | "DANGEROUS_FILE_NAME"
  | "INVALID_EXTENSION"
  | "INVALID_MIME"
  | "INVALID_SIGNATURE"
  | "INVALID_OFFICE_PACKAGE"
  | "MACRO_NOT_ALLOWED"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "FILE_TOO_LARGE";

export class OnboardingUploadError extends Error {
  constructor(public readonly code: OnboardingUploadErrorCode, message: string) {
    super(message);
    this.name = "OnboardingUploadError";
  }
}

type Format = {
  mime: string;
  kind: "pdf" | "text" | "image" | "ole" | "ooxml";
  officeRoot?: string;
};

const FORMATS: Record<string, Format> = {
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  ".txt": { mime: "text/plain", kind: "text" },
  ".csv": { mime: "text/csv", kind: "text" },
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".doc": { mime: "application/msword", kind: "ole" },
  ".xls": { mime: "application/vnd.ms-excel", kind: "ole" },
  ".ppt": { mime: "application/vnd.ms-powerpoint", kind: "ole" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "ooxml", officeRoot: "word/document.xml" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "ooxml", officeRoot: "xl/workbook.xml" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "ooxml", officeRoot: "ppt/presentation.xml" },
};

const DANGEROUS_INNER_EXTENSION = /\.(?:exe|com|scr|bat|cmd|ps1|js|mjs|cjs|vbs|jar|html?|svg|docm|dotm|xlsm|xltm|pptm|potm|ppsm)(?:\.|$)/i;
const OLE_SIGNATURE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function inspectName(fileName: string) {
  if (!fileName || fileName.length > 240 || /[\0-\x1f\x7f/\\]/.test(fileName) || fileName === "." || fileName === "..") {
    throw new OnboardingUploadError("DANGEROUS_FILE_NAME", "文件名包含不安全字符");
  }
  const extension = path.extname(fileName).toLowerCase();
  const format = FORMATS[extension];
  if (!format) throw new OnboardingUploadError("INVALID_EXTENSION", "不支持该文件格式");
  const stem = fileName.slice(0, -extension.length);
  if (DANGEROUS_INNER_EXTENSION.test(stem)) {
    throw new OnboardingUploadError("DANGEROUS_FILE_NAME", "文件名疑似双扩展伪装");
  }
  return { extension, format };
}

async function readPrefix(filePath: string, length: number) {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function validateUtf8Text(filePath: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of createReadStream(filePath)) {
      const bytes = chunk as Buffer;
      if (bytes.includes(0)) throw new Error("NUL");
      decoder.decode(bytes, { stream: true });
    }
    decoder.decode();
  } catch {
    throw new OnboardingUploadError("INVALID_SIGNATURE", "文本文件不是有效的 UTF-8 文本");
  }
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("ZIP_OPEN_FAILED"));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(error ?? new Error("ZIP_ENTRY_OPEN_FAILED")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) stream.destroy(new Error("ZIP_ENTRY_TOO_LARGE"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function validateOoxml(filePath: string, requiredRoot: string, limits: UploadLimits) {
  let zip: ZipFile;
  try {
    zip = await openZip(filePath);
  } catch {
    throw new OnboardingUploadError("INVALID_OFFICE_PACKAGE", "Office 文件不是有效的 OOXML 包");
  }
  const maxEntries = limits.maxArchiveEntries ?? 2_000;
  const maxNameBytes = limits.maxArchiveEntryNameBytes ?? 512;
  const maxUncompressed = limits.maxArchiveUncompressedBytes ?? Math.min(limits.maxBytes * 10, 500 * 1024 * 1024);
  const maxRatio = limits.maxArchiveCompressionRatio ?? 100;
  let entries = 0;
  let uncompressed = 0;
  let sawContentTypes = false;
  let sawRoot = false;
  let contentTypes = "";

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (!settled) { settled = true; resolve(); }
      });
      zip.on("entry", async (entry: Entry) => {
        try {
          entries += 1;
          const name = entry.fileName;
          if (entries > maxEntries || Buffer.byteLength(name, "utf8") > maxNameBytes) {
            throw new OnboardingUploadError("ARCHIVE_LIMIT_EXCEEDED", "Office 压缩包条目超过安全限制");
          }
          if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "..") || (entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new OnboardingUploadError("INVALID_OFFICE_PACKAGE", "Office 压缩包包含不安全条目");
          }
          uncompressed += entry.uncompressedSize;
          const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
          if (uncompressed > maxUncompressed || ratio > maxRatio) {
            throw new OnboardingUploadError("ARCHIVE_LIMIT_EXCEEDED", "Office 压缩包超过解压安全限制");
          }
          if (/vbaProject\.bin$/i.test(name) || /(?:^|\/)activeX\//i.test(name)) {
            throw new OnboardingUploadError("MACRO_NOT_ALLOWED", "Office 宏和 ActiveX 内容不允许上传");
          }
          if (name === requiredRoot) sawRoot = true;
          if (name === "[Content_Types].xml") {
            sawContentTypes = true;
            contentTypes = (await readEntry(zip, entry, 1024 * 1024)).toString("utf8");
            // SheetJS includes an unused default `.bin` macro content type in ordinary
            // .xlsx files. Reject actual macro-enabled package overrides; concrete
            // vbaProject.bin/ActiveX entries are rejected above.
            if (/<Override\b[^>]*ContentType="[^"]*macroEnabled[^"]*"/i.test(contentTypes)) {
              throw new OnboardingUploadError("MACRO_NOT_ALLOWED", "Office 宏内容不允许上传");
            }
          }
          if (!settled) zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof OnboardingUploadError) throw error;
    throw new OnboardingUploadError("INVALID_OFFICE_PACKAGE", "Office 文件结构无效");
  } finally {
    zip.close();
  }
  if (!sawContentTypes || !sawRoot || !contentTypes) {
    throw new OnboardingUploadError("INVALID_OFFICE_PACKAGE", "Office 文件缺少必需的 OOXML 结构");
  }
}

async function validateStaged(filePath: string, fileName: string, format: Format, limits: UploadLimits) {
  if (format.kind === "pdf") {
    const prefix = await readPrefix(filePath, 5);
    if (prefix.toString("ascii") !== "%PDF-") throw new OnboardingUploadError("INVALID_SIGNATURE", "PDF 文件签名无效");
  } else if (format.kind === "ole") {
    const prefix = await readPrefix(filePath, OLE_SIGNATURE.byteLength);
    if (!OLE_SIGNATURE.every((value, index) => prefix[index] === value)) {
      throw new OnboardingUploadError("INVALID_SIGNATURE", "旧版 Office 文件签名无效");
    }
  } else if (format.kind === "text") {
    await validateUtf8Text(filePath);
  } else if (format.kind === "image") {
    const bytes = await readFile(filePath);
    try {
      validatePortalImage({ fileName, mimeType: format.mime, bytes }, limits.maxBytes);
    } catch {
      throw new OnboardingUploadError("INVALID_SIGNATURE", "图片签名或结构无效");
    }
  } else {
    await validateOoxml(filePath, format.officeRoot!, limits);
  }
}

export async function validateOnboardingUpload(file: UploadFileLike, limits: UploadLimits): Promise<ValidatedUpload> {
  const { extension, format } = inspectName(file.fileName);
  if (file.mimeType !== format.mime) throw new OnboardingUploadError("INVALID_MIME", "文件 MIME 类型与扩展名不一致");
  let staged;
  try {
    staged = await stagePrivateUpload(file, limits);
  } catch (error) {
    if (error instanceof PrivateUploadValidationError && error.code === "FILE_TOO_LARGE") {
      throw new OnboardingUploadError("FILE_TOO_LARGE", "文件超过上传大小限制");
    }
    throw error;
  }
  try {
    await validateStaged(staged.stagedPath, file.fileName, format, limits);
    return {
      originalName: file.fileName,
      extension,
      mimeType: file.mimeType,
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256,
      stagedPath: staged.stagedPath,
      cleanup: staged.cleanup,
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

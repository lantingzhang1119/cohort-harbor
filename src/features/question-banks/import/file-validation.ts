import path from "node:path";

import { QuestionBankSource } from "@/generated/prisma/enums";
import {
  OnboardingUploadError,
  validateOnboardingUpload,
} from "@/features/onboarding-kit/file-validation";
import { QuestionBankImportFileError } from "@/features/question-banks/import/import-errors";
import type { QuestionBankImportFileInput } from "@/features/question-banks/import/import-types";

export { QuestionBankImportFileError };

type FormatRule = {
  mimeTypes: readonly string[];
  source: QuestionBankSource;
  signature: (bytes: Uint8Array) => boolean;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((value, index) => bytes[index] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder("ascii").decode(bytes.slice(start, end));

const isZip = (bytes: Uint8Array) =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
  startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);

const isOle = (bytes: Uint8Array) =>
  startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const formatRules: Record<string, FormatRule> = {
  ".pdf": {
    mimeTypes: ["application/pdf"],
    source: QuestionBankSource.PDF,
    signature: (bytes) => ascii(bytes, 0, 5) === "%PDF-",
  },
  ".doc": {
    mimeTypes: ["application/msword"],
    source: QuestionBankSource.WORD,
    signature: isOle,
  },
  ".docx": {
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ],
    source: QuestionBankSource.WORD,
    signature: isZip,
  },
  ".xls": {
    mimeTypes: ["application/vnd.ms-excel", "application/octet-stream"],
    source: QuestionBankSource.EXCEL,
    signature: isOle,
  },
  ".xlsx": {
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    source: QuestionBankSource.EXCEL,
    signature: isZip,
  },
};

const DANGEROUS = /[\0-\x1f\x7f/\\]/;
const DANGEROUS_INNER_EXTENSION = /\.(?:exe|com|scr|bat|cmd|ps1|js|mjs|cjs|vbs|jar|html?|svg|docm|dotm|xlsm|xltm|pptm|potm|ppsm)(?:\.|$)/i;
const MAX_DEFAULT_BYTES = 30 * 1024 * 1024;

export function validateQuestionBankImportFile(
  file: QuestionBankImportFileInput,
  maxBytes = MAX_DEFAULT_BYTES,
) {
  if (!file.fileName || file.fileName.length > 240 || DANGEROUS.test(file.fileName)) {
    throw new QuestionBankImportFileError("DANGEROUS_FILE_NAME", "文件名包含不安全字符");
  }
  const extension = path.extname(file.fileName).toLowerCase();
  const rule = formatRules[extension];
  if (!rule) {
    throw new QuestionBankImportFileError("UNSUPPORTED_FORMAT", "仅支持 Word、Excel 或 PDF 题库文件");
  }
  const stem = file.fileName.slice(0, -extension.length);
  if (DANGEROUS_INNER_EXTENSION.test(stem)) {
    throw new QuestionBankImportFileError("DANGEROUS_FILE_NAME", "文件名疑似双扩展伪装");
  }
  if (file.bytes.byteLength > maxBytes) {
    throw new QuestionBankImportFileError("FILE_TOO_LARGE", "题库文件超过允许大小");
  }
  const mime = (file.mimeType || "").toLowerCase().trim();
  // Browsers may send empty MIME or generic application/octet-stream; signature still must match.
  const mimeOk =
    !mime ||
    mime === "application/octet-stream" ||
    rule.mimeTypes.includes(mime);
  if (!mimeOk) {
    throw new QuestionBankImportFileError("INVALID_MIME", "文件扩展名与 MIME 类型不一致");
  }
  if (!rule.signature(file.bytes)) {
    throw new QuestionBankImportFileError("INVALID_SIGNATURE", "文件内容与声明格式不一致");
  }
  return {
    extension,
    mimeType: rule.mimeTypes[0]!,
    source: rule.source,
  };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function validateAndStageQuestionBankImportFile(
  file: QuestionBankImportFileInput,
  options: { tempRoot: string; maxBytes?: number },
) {
  const descriptor = validateQuestionBankImportFile(file, options.maxBytes);
  try {
    const staged = await validateOnboardingUpload(
      {
        fileName: file.fileName,
        // The shallow check already reconciled browser MIME with signature. The shared
        // Office validator receives the canonical MIME so it can focus on package safety.
        mimeType: descriptor.mimeType,
        size: file.bytes.byteLength,
        stream: () => byteStream(file.bytes),
      },
      {
        maxBytes: options.maxBytes ?? MAX_DEFAULT_BYTES,
        maxArchiveEntries: 2_000,
        maxArchiveEntryNameBytes: 512,
        maxArchiveUncompressedBytes: 300 * 1024 * 1024,
        maxArchiveCompressionRatio: 100,
        tempRoot: options.tempRoot,
      },
    );
    return { descriptor, staged };
  } catch (error) {
    if (error instanceof OnboardingUploadError) {
      const code =
        error.code === "MACRO_NOT_ALLOWED"
          ? "MACRO_NOT_ALLOWED"
          : error.code === "ARCHIVE_LIMIT_EXCEEDED"
            ? "ARCHIVE_LIMIT_EXCEEDED"
            : error.code === "FILE_TOO_LARGE"
              ? "FILE_TOO_LARGE"
              : "INVALID_PACKAGE";
      throw new QuestionBankImportFileError(code, error.message);
    }
    throw error;
  }
}

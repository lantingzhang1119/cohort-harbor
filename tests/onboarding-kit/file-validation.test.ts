import { once } from "node:events";

import { ZipArchive } from "archiver";
import { describe, expect, it } from "vitest";

import {
  OnboardingUploadError,
  validateOnboardingUpload,
} from "@/features/onboarding-kit/file-validation";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { validGif, validJpeg, validPng, validWebp } from "../fixtures/portal-images";

function upload(fileName: string, mimeType: string, bytes: Uint8Array): UploadFileLike {
  return {
    fileName,
    mimeType,
    size: bytes.byteLength,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}

async function zip(entries: Array<{ name: string; bytes: Uint8Array | string }>) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  for (const entry of entries) archive.append(Buffer.from(entry.bytes), { name: entry.name });
  const ended = once(archive, "end");
  await archive.finalize();
  await ended;
  return Buffer.concat(chunks);
}

const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

async function ooxml(kind: "word" | "xl" | "ppt") {
  const root = kind === "word" ? "word/document.xml" : kind === "xl" ? "xl/workbook.xml" : "ppt/presentation.xml";
  return zip([
    { name: "[Content_Types].xml", bytes: contentTypes },
    { name: "_rels/.rels", bytes: "<Relationships/>" },
    { name: root, bytes: "<root/>" },
  ]);
}

const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

describe("onboarding material file validation", () => {
  it("accepts every documented safe extension with matching MIME and signature", async () => {
    const files: Array<[string, string, Uint8Array]> = [
      ["手册.pdf", "application/pdf", Buffer.from("%PDF-1.7\n%%EOF")],
      ["说明.txt", "text/plain", Buffer.from("安全文本", "utf8")],
      ["名单.csv", "text/csv", Buffer.from("姓名,工号\n示例员工,E001", "utf8")],
      ["图片.png", "image/png", validPng()],
      ["照片.jpg", "image/jpeg", validJpeg()],
      ["照片.jpeg", "image/jpeg", validJpeg()],
      ["动图.gif", "image/gif", validGif()],
      ["图片.webp", "image/webp", validWebp()],
      ["旧文档.doc", "application/msword", ole],
      ["旧表格.xls", "application/vnd.ms-excel", ole],
      ["旧演示.ppt", "application/vnd.ms-powerpoint", ole],
      ["文档.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await ooxml("word")],
      ["表格.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await ooxml("xl")],
      ["演示.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", await ooxml("ppt")],
    ];

    for (const [fileName, mimeType, bytes] of files) {
      const result = await validateOnboardingUpload(upload(fileName, mimeType, bytes), {
        maxBytes: 5 * 1024 * 1024,
      });
      expect(result).toMatchObject({
        originalName: fileName,
        mimeType,
        sizeBytes: bytes.byteLength,
      });
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      await result.cleanup();
    }
  });

  it.each([
    ["wrong MIME", upload("手册.pdf", "text/plain", Buffer.from("%PDF-1.7")), "INVALID_MIME"],
    ["wrong signature", upload("手册.pdf", "application/pdf", Buffer.from("not pdf")), "INVALID_SIGNATURE"],
    ["executable", upload("恶意.exe", "application/octet-stream", Buffer.from("MZ")), "INVALID_EXTENSION"],
    ["HTML", upload("说明.html", "text/html", Buffer.from("<script/>", "utf8")), "INVALID_EXTENSION"],
    ["SVG", upload("图.svg", "image/svg+xml", Buffer.from("<svg/>", "utf8")), "INVALID_EXTENSION"],
    ["macro extension", upload("宏.docm", "application/vnd.ms-word.document.macroEnabled.12", Buffer.from("PK")), "INVALID_EXTENSION"],
    ["double extension", upload("制度.exe.pdf", "application/pdf", Buffer.from("%PDF-1.7")), "DANGEROUS_FILE_NAME"],
    ["path separator", upload("部门/制度.pdf", "application/pdf", Buffer.from("%PDF-1.7")), "DANGEROUS_FILE_NAME"],
    ["NUL", upload("制度\0.pdf", "application/pdf", Buffer.from("%PDF-1.7")), "DANGEROUS_FILE_NAME"],
  ] as const)("rejects %s", async (_case, file, code) => {
    await expect(validateOnboardingUpload(file, { maxBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ code });
  });

  it("rejects malformed, structurally incomplete, macro-enabled and bomb-like OOXML", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const malformed = upload("broken.docx", mime, Buffer.from("PK-not-a-zip"));
    const missingRoot = upload("missing.docx", mime, await zip([
      { name: "[Content_Types].xml", bytes: contentTypes },
      { name: "other.xml", bytes: "<x/>" },
    ]));
    const macro = upload("macro.docx", mime, await zip([
      { name: "[Content_Types].xml", bytes: `${contentTypes} macroEnabled vbaProject` },
      { name: "word/document.xml", bytes: "<x/>" },
      { name: "word/vbaProject.bin", bytes: "macro" },
    ]));
    const bomb = upload("bomb.docx", mime, await zip([
      { name: "[Content_Types].xml", bytes: contentTypes },
      { name: "word/document.xml", bytes: "x".repeat(10_000) },
    ]));

    await expect(validateOnboardingUpload(malformed, { maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(OnboardingUploadError);
    await expect(validateOnboardingUpload(missingRoot, { maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "INVALID_OFFICE_PACKAGE" });
    await expect(validateOnboardingUpload(macro, { maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "MACRO_NOT_ALLOWED" });
    await expect(validateOnboardingUpload(bomb, {
      maxBytes: 1024 * 1024,
      maxArchiveUncompressedBytes: 1_000,
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
  });

  it("rejects declared and streamed oversize files and cleans its temporary staging file", async () => {
    const oversized = upload("large.txt", "text/plain", Buffer.alloc(10));
    await expect(validateOnboardingUpload(oversized, { maxBytes: 9 }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    const liedAboutSize: UploadFileLike = {
      ...upload("large.txt", "text/plain", Buffer.alloc(10)),
      size: 1,
    };
    await expect(validateOnboardingUpload(liedAboutSize, { maxBytes: 9 }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

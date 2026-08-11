import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOcrLanguages, runLocalOcr } from "@/features/question-banks/import/ocr/tesseract-runtime";
import { renderPdfPagesToPng } from "@/features/question-banks/import/ocr/pdf-render";
import { parsePdfOcrQuestionBank } from "@/features/question-banks/import/parsers/pdf-ocr-parser";
import { createTextPdf } from "../fixtures/question-bank-import";

const cleanups: Array<() => Promise<void>> = [];

function createJpegImagePdf(jpeg: Buffer, width: number, height: number): Uint8Array {
  const content = Buffer.from("q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n", "ascii");
  const objects = [
    Buffer.from("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n", "ascii"),
    Buffer.from("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n", "ascii"),
    Buffer.from("3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>endobj\n", "ascii"),
    Buffer.concat([
      Buffer.from(`4 0 obj<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>stream\n`, "ascii"),
      jpeg,
      Buffer.from("\nendstream\nendobj\n", "ascii"),
    ]),
    Buffer.concat([
      Buffer.from(`5 0 obj<< /Length ${content.byteLength} >>stream\n`, "ascii"),
      content,
      Buffer.from("endstream\nendobj\n", "ascii"),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let offset = parts[0]!.byteLength;
  for (const object of objects) {
    offsets.push(offset);
    parts.push(object);
    offset += object.byteLength;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "ascii"));
  return new Uint8Array(Buffer.concat(parts));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

describe("question bank local OCR runtime", () => {
  it("loads local chi_sim and eng traineddata without cloud", async () => {
    const loaded = await loadOcrLanguages(["chi_sim", "eng"]);
    expect(loaded.languages).toEqual(expect.arrayContaining(["chi_sim", "eng"]));
    expect(loaded.langPath).toMatch(/tessdata/);
    expect(loaded.source).toBe("local");
  });

  it("OCR recognizes Chinese text from a rendered image", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-ocr-img-"));
    cleanups.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    });
    const imagePath = path.join(directory, "zh.png");
    // Large high-contrast Chinese glyphs improve deterministic OCR in CI.
    const svg = `
      <svg width="900" height="220" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <text x="40" y="120" font-size="72" font-family="Noto Sans SC, PingFang SC, sans-serif" fill="black">单选题</text>
      </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(imagePath);
    const result = await runLocalOcr(imagePath, { languages: ["chi_sim", "eng"] });
    expect(result.text).toMatch(/单选|题/);
    expect(result.confidence).toBeGreaterThan(0);
  }, 120_000);

  it("renders pdf pages via pdftoppm with isolated cleanup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-pdf-render-"));
    cleanups.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    });
    const pdfPath = path.join(directory, "sample.pdf");
    await writeFile(pdfPath, createTextPdf(["OCR SAMPLE LINE"]));
    const rendered = await renderPdfPagesToPng(pdfPath, {
      workDirectory: path.join(directory, "out"),
      timeoutMs: 30_000,
    });
    expect(rendered.pages.length).toBe(1);
    expect(rendered.pages[0]!.absolutePath.endsWith(".png")).toBe(true);
    await rendered.cleanup();
    const { access } = await import("node:fs/promises");
    await expect(access(rendered.pages[0]!.absolutePath)).rejects.toBeTruthy();
  }, 60_000);

  it("replaces an invalid host fontconfig before invoking pdftoppm", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-pdf-fontconfig-"));
    cleanups.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    });
    const pdfPath = path.join(directory, "sample.pdf");
    const executable = path.join(directory, "pdftoppm-fixture");
    await writeFile(pdfPath, createTextPdf(["FONTCONFIG SAMPLE"]));
    await writeFile(
      executable,
      `#!/bin/sh
set -eu
test -f "\${FONTCONFIG_FILE:-}"
for argument in "$@"; do prefix="$argument"; done
: > "\${prefix}-1.png"
`,
    );
    await chmod(executable, 0o700);
    vi.stubEnv("FONTCONFIG_FILE", path.join(directory, "missing-fonts.conf"));

    const rendered = await renderPdfPagesToPng(pdfPath, {
      workDirectory: path.join(directory, "out"),
      pdftoppmPath: executable,
    });

    expect(rendered.pages).toHaveLength(1);
    await rendered.cleanup();
  });

  it("runs the scanned-PDF pipeline through local OCR and creates a reviewable draft", async () => {
    const svg = `
      <svg width="1200" height="1000" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <g font-size="54" font-family="Noto Sans SC, PingFang SC, sans-serif" fill="black">
          <text x="70" y="100">中文扫描题库</text>
          <text x="70" y="200">1. [SINGLE] One plus one equals?</text>
          <text x="100" y="300">A. 1</text>
          <text x="100" y="380">B. 2</text>
          <text x="100" y="460">C. 3</text>
          <text x="100" y="540">D. 4</text>
          <text x="70" y="650">Answer: B</text>
          <text x="70" y="740">Score: 100</text>
        </g>
      </svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
    const result = await parsePdfOcrQuestionBank(createJpegImagePdf(jpeg, 1200, 1000), {
      timeoutMs: 120_000,
    });

    expect(result.source).toBe("OCR");
    expect(result.extraction).toMatchObject({ ocrUsed: true, language: "chi_sim+eng" });
    expect(result.warnings.some((warning) => warning.code === "OCR_USED")).toBe(true);
    expect(result.questions.length).toBeGreaterThanOrEqual(1);
    expect(result.questions.some((question) => question.needsReview)).toBe(true);
    expect(result.sourceFragments.some((fragment) => fragment.page === 1)).toBe(true);
  }, 180_000);
});

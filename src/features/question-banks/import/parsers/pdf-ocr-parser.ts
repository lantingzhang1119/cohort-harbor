import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QuestionBankSource } from "@/generated/prisma/enums";
import { renderPdfPagesToPng } from "@/features/question-banks/import/ocr/pdf-render";
import { runLocalOcr } from "@/features/question-banks/import/ocr/tesseract-runtime";
import { extractPdfPageTexts } from "@/features/question-banks/import/parsers/pdf-text-parser";
import { recognizeStructure } from "@/features/question-banks/import/parsers/structure-recognizer";
import type { ParseResult } from "@/features/question-banks/import/import-types";

export async function parsePdfOcrQuestionBank(
  bytes: Uint8Array,
  options: {
    languages?: string[];
    timeoutMs?: number;
    ocrTimeoutMs?: number;
    pageCount?: number;
    maxPages?: number;
  } = {},
): Promise<ParseResult> {
  const pageCount = options.pageCount ?? (await extractPdfPageTexts(bytes)).length;
  const maxPages = options.maxPages ?? 100;
  if (pageCount < 1) throw new Error("PDF 不包含可识别页面");
  if (pageCount > maxPages) throw new Error(`扫描 PDF 超过 ${maxPages} 页导入上限`);
  const root = await mkdtemp(path.join(tmpdir(), "cohort-harbor-qb-ocr-"));
  const pdfPath = path.join(root, "source.pdf");
  try {
    await writeFile(pdfPath, bytes, { mode: 0o600 });
    const rendered = await renderPdfPagesToPng(pdfPath, {
      workDirectory: path.join(root, "pages"),
      timeoutMs: options.timeoutMs ?? 90_000,
      firstPage: 1,
      lastPage: pageCount,
    });
    const lines: string[] = [];
    const pageByLine: Array<number | undefined> = [];
    const lowConfidencePages: number[] = [];
    let language = (options.languages ?? ["chi_sim", "eng"]).join("+");

    for (const page of rendered.pages) {
      const ocr = await runLocalOcr(page.absolutePath, {
        languages: options.languages,
        timeoutMs: options.ocrTimeoutMs ?? options.timeoutMs ?? 90_000,
      });
      language = ocr.languages.join("+");
      if (ocr.confidence > 0 && ocr.confidence < 55) {
        lowConfidencePages.push(page.page);
      }
      const pageLines = ocr.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of pageLines) {
        lines.push(line);
        pageByLine.push(page.page);
      }
    }

    const recognized = recognizeStructure({
      bankName: "OCR 导入题库",
      lines,
      pageByLine,
      mode: "BEST_EFFORT",
    });

    const warnings = [
      { code: "OCR_USED", message: "扫描 PDF 已使用本地 OCR（非云服务）" },
      ...recognized.warnings,
    ];
    for (const page of lowConfidencePages) {
      warnings.push({
        code: "OCR_LOW_CONFIDENCE",
        message: `第 ${page} 页 OCR 置信度偏低，请人工复核`,
      });
    }

    return {
      bankName: recognized.bankName,
      mode: "BEST_EFFORT",
      source: QuestionBankSource.OCR,
      questions: recognized.questions.map((question) => ({
        ...question,
        needsReview: true,
        reviewReasons: question.reviewReasons.includes("OCR 识别结果")
          ? question.reviewReasons
          : [...question.reviewReasons, "OCR 识别结果"],
      })),
      sourceFragments: recognized.sourceFragments,
      warnings,
      extraction: {
        pages: rendered.pages.length,
        ocrUsed: true,
        language,
        format: "pdf-ocr",
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

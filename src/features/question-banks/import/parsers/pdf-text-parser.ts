import { QuestionBankSource } from "@/generated/prisma/enums";
import { recognizeStructure } from "@/features/question-banks/import/parsers/structure-recognizer";
import type { ParseResult } from "@/features/question-banks/import/import-types";

export type ExtractedPdfPageText = { page: number; text: string; lines: string[] };

function groupTextItemsByLine(
  items: readonly unknown[],
): string[] {
  const positioned = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (!String(record.str ?? "").trim()) return [];
    const transform = Array.isArray(record.transform) ? record.transform : [];
    return [{ text: String(record.str), x: Number(transform[4] ?? 0), y: Number(transform[5] ?? 0) }];
  });
  const rows: Array<{ y: number; items: Array<{ text: string; x: number }> }> = [];
  for (const item of positioned.sort((left, right) => right.y - left.y || left.x - right.x)) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push({ text: item.text, x: item.x });
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => row.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(" ").trim())
    .filter(Boolean);
}

export async function extractPdfPageTexts(bytes: Uint8Array): Promise<ExtractedPdfPageText[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
  try {
    const document = await loadingTask.promise;
    const pages: ExtractedPdfPageText[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = groupTextItemsByLine(content.items);
      const text = lines.join("\n").trim();
      pages.push({ page: pageNumber, text, lines });
    }
    return pages;
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export function isLikelyScannedPdf(pages: Array<{ text: string }>): boolean {
  if (!pages.length) return true;
  const total = pages.reduce((sum, page) => sum + page.text.replace(/\s+/g, "").length, 0);
  const average = total / pages.length;
  return average < 20;
}

export async function parsePdfTextQuestionBank(bytes: Uint8Array): Promise<ParseResult> {
  const pages = await extractPdfPageTexts(bytes);
  const lines: string[] = [];
  const pageByLine: Array<number | undefined> = [];
  for (const page of pages) {
    // Keep page-level text and also split by common separators for structure recognition.
    const pageLines = page.lines.length
      ? page.lines
      : page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!pageLines.length && page.text) pageLines.push(page.text);
    for (const line of pageLines) {
      lines.push(line);
      pageByLine.push(page.page);
    }
  }

  const recognized = recognizeStructure({
    bankName: "PDF 导入题库",
    lines,
    pageByLine,
    mode: "BEST_EFFORT",
  });

  return {
    bankName: recognized.bankName,
    mode: "BEST_EFFORT",
    source: QuestionBankSource.PDF,
    questions: recognized.questions.map((question) => ({
      ...question,
      needsReview: true,
      reviewReasons: question.reviewReasons.includes("PDF 尽力识别")
        ? question.reviewReasons
        : [...question.reviewReasons, "PDF 尽力识别"],
    })),
    sourceFragments: recognized.sourceFragments,
    warnings: [
      { code: "BEST_EFFORT", message: "文字 PDF 已尽力识别，需人工确认" },
      ...recognized.warnings,
    ],
    extraction: {
      pages: pages.length,
      ocrUsed: false,
      format: "pdf-text",
    },
  };
}

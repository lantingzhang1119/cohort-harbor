import { describe, expect, it } from "vitest";

import * as XLSX from "xlsx";

import {
  buildExcelTemplateBytes,
  buildWordTemplateBytes,
  getTemplateInstructionsMarkdown,
} from "@/features/question-banks/import/templates/template-files";
import { parseExcelQuestionBank } from "@/features/question-banks/import/parsers/excel-parser";
import { parseWordQuestionBank } from "@/features/question-banks/import/parsers/word-parser";

describe("question bank import templates", () => {
  it("provides downloadable standard excel template that parses deterministically", async () => {
    const bytes = buildExcelTemplateBytes();
    const workbook = XLSX.read(bytes, { type: "array" });
    expect(workbook.SheetNames.length).toBeGreaterThan(0);
    const parsed = await parseExcelQuestionBank(bytes);
    expect(parsed.mode).toBe("TEMPLATE");
    expect(parsed.questions.length).toBeGreaterThanOrEqual(1);
    expect(parsed.questions.every((question) => !question.needsReview)).toBe(true);
  });

  it("provides downloadable standard word template that parses deterministically", async () => {
    const bytes = buildWordTemplateBytes();
    const parsed = await parseWordQuestionBank(bytes);
    expect(parsed.mode).toBe("TEMPLATE");
    expect(parsed.questions.length).toBeGreaterThanOrEqual(1);
  });

  it("includes filling instructions", () => {
    const markdown = getTemplateInstructionsMarkdown();
    expect(markdown).toMatch(/题型/);
    expect(markdown).toMatch(/答案/);
    expect(markdown).toMatch(/分值/);
  });
});

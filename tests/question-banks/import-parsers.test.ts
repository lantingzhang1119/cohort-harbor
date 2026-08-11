import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { parseExcelQuestionBank } from "@/features/question-banks/import/parsers/excel-parser";
import { parseWordQuestionBank } from "@/features/question-banks/import/parsers/word-parser";
import { parsePdfTextQuestionBank } from "@/features/question-banks/import/parsers/pdf-text-parser";
import { recognizeStructure } from "@/features/question-banks/import/parsers/structure-recognizer";
import {
  createBrokenNumberWordDocument,
  createMissingAnswerExcelWorkbook,
  createStandardExcelWorkbook,
  createStandardTextPdf,
  createStandardWordDocument,
} from "../fixtures/question-bank-import";

describe("question bank import parsers", () => {
  it("keeps PDF.js external to the Next server bundle so its worker remains resolvable", async () => {
    const config = await readFile(path.resolve(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/serverExternalPackages:\s*\[[^\]]*"pdfjs-dist"/s);
    expect(config).toMatch(/serverExternalPackages:\s*\[[^\]]*"tesseract\.js"/s);
  });

  it("deterministically parses standard excel mixed template", async () => {
    const result = await parseExcelQuestionBank(createStandardExcelWorkbook());
    expect(result.mode).toBe("TEMPLATE");
    expect(result.questions).toHaveLength(3);
    expect(result.questions[0]).toMatchObject({
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "一加一等于几？",
      score: 40,
      needsReview: false,
    });
    expect(result.questions[0]!.options.find((option) => option.label === "B")?.isCorrect).toBe(true);
    expect(result.questions[1]!.type).toBe(QuestionBankQuestionType.MULTIPLE_CHOICE);
    expect(result.questions[2]).toMatchObject({
      type: QuestionBankQuestionType.FILL_BLANK,
      blanks: [{ blankIndex: 0, acceptableAnswers: expect.arrayContaining(["北京", "Beijing"]) }],
    });
    expect(result.questions.every((question) => question.sourceFragmentIds.length > 0)).toBe(true);
  });

  it("marks missing answers as needsReview without guessing", async () => {
    const result = await parseExcelQuestionBank(createMissingAnswerExcelWorkbook());
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.needsReview).toBe(true);
    expect(result.questions[0]!.options.every((option) => option.isCorrect === false || option.isCorrect === null)).toBe(true);
    expect(result.questions[0]!.options.some((option) => option.isCorrect === true)).toBe(false);
    expect(result.warnings.some((warning) => /答案/.test(warning.message))).toBe(true);
  });

  it("deterministically parses standard word mixed template", async () => {
    const result = await parseWordQuestionBank(createStandardWordDocument());
    expect(result.mode).toBe("TEMPLATE");
    expect(result.bankName).toContain("通用知识");
    expect(result.questions).toHaveLength(3);
    expect(result.questions[1]!.options.filter((option) => option.isCorrect).map((option) => option.label)).toEqual(["B", "D"]);
    expect(result.questions.every((question) => !question.needsReview)).toBe(true);
  });

  it("flags broken question numbers for review", async () => {
    const result = await parseWordQuestionBank(createBrokenNumberWordDocument());
    expect(result.questions).toHaveLength(2);
    expect(result.warnings.some((warning) => /题号/.test(warning.message))).toBe(true);
    expect(result.questions.some((question) => question.needsReview)).toBe(true);
  });

  it("extracts text pdf pages with page mapping", async () => {
    const result = await parsePdfTextQuestionBank(createStandardTextPdf());
    expect(result.mode).toBe("BEST_EFFORT");
    expect(result.sourceFragments.some((fragment) => fragment.page === 1)).toBe(true);
    expect(result.questions.length).toBeGreaterThanOrEqual(1);
    expect(result.questions[0]!.sourceFragmentIds.length).toBeGreaterThan(0);
    expect(result.questions[0]).toMatchObject({
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      score: 100,
    });
    expect(result.questions[0]!.options).toHaveLength(4);
    expect(result.questions[0]!.options.find((option) => option.label === "B")?.isCorrect).toBe(true);
  });

  it("best-effort recognizer requires review when answer is uncertain", () => {
    const result = recognizeStructure({
      bankName: "任意格式",
      lines: [
        "1. 颜色题",
        "A 红",
        "B 蓝",
        // no answer line
      ],
      mode: "BEST_EFFORT",
    });
    expect(result.questions[0]!.needsReview).toBe(true);
    expect(result.questions[0]!.options.some((option) => option.isCorrect === true)).toBe(false);
  });
});

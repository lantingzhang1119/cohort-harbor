import { describe, expect, it } from "vitest";

import {
  QuestionBankImportFileError,
  validateQuestionBankImportFile,
} from "@/features/question-banks/import/file-validation";
import {
  TINY_PNG,
  createStandardExcelWorkbook,
  createStandardTextPdf,
  createStandardWordDocument,
} from "../fixtures/question-bank-import";

describe("question bank import file validation", () => {
  it("accepts word/excel/pdf when extension, MIME and signature agree", () => {
    expect(
      validateQuestionBankImportFile({
        fileName: "bank.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: createStandardWordDocument(),
      }),
    ).toMatchObject({ extension: ".docx", source: "WORD" });

    expect(
      validateQuestionBankImportFile({
        fileName: "bank.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: createStandardExcelWorkbook(),
      }),
    ).toMatchObject({ extension: ".xlsx", source: "EXCEL" });

    expect(
      validateQuestionBankImportFile({
        fileName: "bank.pdf",
        mimeType: "application/pdf",
        bytes: createStandardTextPdf(),
      }),
    ).toMatchObject({ extension: ".pdf", source: "PDF" });
  });

  it("rejects spoofed MIME, wrong signatures and unsupported formats", () => {
    expect(() =>
      validateQuestionBankImportFile({
        fileName: "bank.pdf",
        mimeType: "application/pdf",
        bytes: TINY_PNG,
      }),
    ).toThrow(QuestionBankImportFileError);

    expect(() =>
      validateQuestionBankImportFile({
        fileName: "bank.docx",
        mimeType: "text/plain",
        bytes: createStandardWordDocument(),
      }),
    ).toThrow(QuestionBankImportFileError);

    expect(() =>
      validateQuestionBankImportFile({
        fileName: "bank.html",
        mimeType: "text/html",
        bytes: new TextEncoder().encode("<script>"),
      }),
    ).toThrow(QuestionBankImportFileError);
  });
});

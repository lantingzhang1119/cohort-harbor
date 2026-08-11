import * as XLSX from "xlsx";

import { QuestionBankQuestionType, QuestionBankSource } from "@/generated/prisma/enums";
import {
  createFragment,
  createLocalId,
  recognizeStructure,
} from "@/features/question-banks/import/parsers/structure-recognizer";
import type {
  DraftQuestion,
  ImportWarning,
  ParseResult,
  SourceFragment,
} from "@/features/question-banks/import/import-types";

const REQUIRED_HEADERS = ["题号", "题型", "题干", "答案", "分值"] as const;
const OPTION_HEADERS = ["选项A", "选项B", "选项C", "选项D", "选项E", "选项F", "选项G", "选项H"] as const;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeHeader(value: unknown): string {
  return cellText(value).replaceAll(/\s+/g, "");
}

function parseType(raw: string): QuestionBankQuestionType | null {
  const key = raw.trim().toLowerCase();
  if (["单选", "单选题", "single", "single_choice"].includes(key)) return QuestionBankQuestionType.SINGLE_CHOICE;
  if (["多选", "多选题", "multiple", "multiple_choice"].includes(key)) return QuestionBankQuestionType.MULTIPLE_CHOICE;
  if (["填空", "填空题", "fill", "fill_blank"].includes(key)) return QuestionBankQuestionType.FILL_BLANK;
  return null;
}

function parseChoiceLabels(raw: string): string[] {
  return raw
    .split(/[,，;；、|/]+/)
    .flatMap((token) => {
      const trimmed = token.trim().toUpperCase();
      if (/^[A-H]+$/.test(trimmed) && trimmed.length > 1) return trimmed.split("");
      return [trimmed];
    })
    .filter((token) => /^[A-H]$/.test(token));
}

function isStandardTemplate(headers: string[]): boolean {
  return REQUIRED_HEADERS.every((header) => headers.includes(header));
}

function parseStandardSheet(
  rows: unknown[][],
  headers: string[],
): ParseResult {
  const warnings: ImportWarning[] = [];
  const sourceFragments: SourceFragment[] = [];
  const questions: DraftQuestion[] = [];
  const headerIndex = new Map(headers.map((header, index) => [header, index]));

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const get = (header: string) => cellText(row[headerIndex.get(header) ?? -1]);
    if (!get("题号") && !get("题干")) continue;

    const snippetParts = headers.map((header) => `${header}:${get(header)}`).filter((part) => !part.endsWith(":"));
    const fragment = createFragment(snippetParts.join(" | "));
    sourceFragments.push(fragment);

    const type = parseType(get("题型"));
    const prompt = get("题干");
    const answerRaw = get("答案");
    const scoreRaw = get("分值");
    const score = scoreRaw ? Number(scoreRaw) : null;
    const reviewReasons: string[] = [];
    let needsReview = false;

    const options = OPTION_HEADERS.flatMap((header) => {
      const text = get(header);
      if (!text) return [];
      const label = header.replace("选项", "");
      return [{ label, text, isCorrect: null as boolean | null }];
    });

    const blanks: DraftQuestion["blanks"] = [];

    if (!type) {
      reviewReasons.push("题型无法识别");
      needsReview = true;
    }
    if (!prompt) {
      reviewReasons.push("缺少题干");
      needsReview = true;
    }
    if (score === null || !Number.isInteger(score) || score <= 0) {
      reviewReasons.push("缺少有效分值");
      needsReview = true;
    }

    if (type === QuestionBankQuestionType.FILL_BLANK) {
      const answers = answerRaw
        .split(/[,，;；|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (!answers.length) {
        reviewReasons.push("填空题缺少答案");
        needsReview = true;
      }
      blanks.push({ blankIndex: 0, acceptableAnswers: answers });
    } else if (type === QuestionBankQuestionType.SINGLE_CHOICE || type === QuestionBankQuestionType.MULTIPLE_CHOICE) {
      if (options.length < 2) {
        reviewReasons.push("选择题选项不足");
        needsReview = true;
      }
      const labels = parseChoiceLabels(answerRaw);
      if (!labels.length) {
        reviewReasons.push("缺少答案");
        needsReview = true;
        for (const option of options) option.isCorrect = null;
      } else {
        for (const option of options) {
          option.isCorrect = labels.includes(option.label);
        }
        const correctCount = options.filter((option) => option.isCorrect).length;
        if (type === QuestionBankQuestionType.SINGLE_CHOICE && correctCount !== 1) {
          reviewReasons.push("单选题正确答案数量异常");
          needsReview = true;
        }
        if (type === QuestionBankQuestionType.MULTIPLE_CHOICE && correctCount < 2) {
          reviewReasons.push("多选题正确答案不足");
          needsReview = true;
        }
      }
    }

    for (const reason of reviewReasons) {
      warnings.push({
        code: "NEEDS_REVIEW",
        message: reason,
        questionIndex: questions.length,
        fragmentId: fragment.id,
      });
    }

    questions.push({
      localId: createLocalId(),
      sequence: questions.length + 1,
      type,
      prompt,
      score: score && Number.isInteger(score) && score > 0 ? score : null,
      options,
      blanks,
      needsReview,
      reviewReasons,
      sourceFragmentIds: [fragment.id],
      originalSnippet: fragment.text,
    });
  }

  return {
    bankName: "Excel 导入题库",
    mode: "TEMPLATE",
    source: QuestionBankSource.EXCEL,
    questions,
    sourceFragments,
    warnings,
    extraction: { format: "xlsx-template" },
  };
}

export async function parseExcelQuestionBank(bytes: Uint8Array): Promise<ParseResult> {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      bankName: "Excel 导入题库",
      mode: "BEST_EFFORT",
      source: QuestionBankSource.EXCEL,
      questions: [],
      sourceFragments: [],
      warnings: [{ code: "WORKBOOK_EMPTY", message: "工作簿为空" }],
    };
  }
  const sheet = workbook.Sheets[sheetName]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
  if (!rows.length) {
    return {
      bankName: "Excel 导入题库",
      mode: "BEST_EFFORT",
      source: QuestionBankSource.EXCEL,
      questions: [],
      sourceFragments: [],
      warnings: [{ code: "WORKBOOK_EMPTY", message: "工作表为空" }],
    };
  }

  const headers = (rows[0] ?? []).map(normalizeHeader);
  if (isStandardTemplate(headers)) {
    return parseStandardSheet(rows, headers);
  }

  // Best-effort: flatten all cells into lines for structure recognition.
  const lines: string[] = [];
  for (const row of rows) {
    const cells = (row as unknown[]).map(cellText).filter(Boolean);
    if (cells.length) lines.push(cells.join(" "));
  }
  const recognized = recognizeStructure({ lines, mode: "BEST_EFFORT", bankName: "Excel 导入题库" });
  return {
    bankName: recognized.bankName,
    mode: "BEST_EFFORT",
    source: QuestionBankSource.EXCEL,
    questions: recognized.questions.map((question) => ({
      ...question,
      needsReview: true,
      reviewReasons: question.reviewReasons.includes("非标准模板尽力识别")
        ? question.reviewReasons
        : [...question.reviewReasons, "非标准模板尽力识别"],
    })),
    sourceFragments: recognized.sourceFragments,
    warnings: [
      { code: "BEST_EFFORT", message: "非标准 Excel 模板，已尽力识别，需人工确认" },
      ...recognized.warnings,
    ],
    extraction: { format: "xlsx-best-effort" },
  };
}

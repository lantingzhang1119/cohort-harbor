import { randomUUID } from "node:crypto";

import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import type {
  DraftQuestion,
  ImportParseMode,
  ImportWarning,
  SourceFragment,
} from "@/features/question-banks/import/import-types";

const TYPE_ALIASES: Record<string, QuestionBankQuestionType> = {
  单选: QuestionBankQuestionType.SINGLE_CHOICE,
  单选题: QuestionBankQuestionType.SINGLE_CHOICE,
  选择题: QuestionBankQuestionType.SINGLE_CHOICE,
  single: QuestionBankQuestionType.SINGLE_CHOICE,
  single_choice: QuestionBankQuestionType.SINGLE_CHOICE,
  多选: QuestionBankQuestionType.MULTIPLE_CHOICE,
  多选题: QuestionBankQuestionType.MULTIPLE_CHOICE,
  multiple: QuestionBankQuestionType.MULTIPLE_CHOICE,
  multiple_choice: QuestionBankQuestionType.MULTIPLE_CHOICE,
  填空: QuestionBankQuestionType.FILL_BLANK,
  填空题: QuestionBankQuestionType.FILL_BLANK,
  fill: QuestionBankQuestionType.FILL_BLANK,
  fill_blank: QuestionBankQuestionType.FILL_BLANK,
};

const OPTION_LINE = /^(?:选项\s*)?([A-H])[\.、\.\)\s]+(.+)$/i;
const ANSWER_LINE = /^(?:答案|正确答案|参考答案)\s*[:：]?\s*(.+)$|^(?:answer|correct answer)\s*[:：]\s*(.+)$/i;
const SCORE_LINE = /^(?:分值|分数|得分|score)\s*[:：]?\s*(\d+)\s*$/i;
const TYPE_LINE = /^(?:题型\s*[:：]?\s*|type\s*[:：]\s*)(.+)$/i;
const PROMPT_LINE = /^(?:题干\s*[:：]?\s*|question\s*[:：]\s*)(.+)$/i;
const NUMBER_LINE = /^(?:【?题号】?|Q)?\s*(\d{1,4})[\.、\.\)\s]+(.*)$/i;
const MARKED_NUMBER = /^【题号】\s*(\d+)\s*$/;
const MARKED_TYPE = /^【题型】\s*(.+)\s*$/;
const MARKED_PROMPT = /^【题干】\s*(.*)\s*$/;
const MARKED_ANSWER = /^【答案】\s*(.*)\s*$/;
const MARKED_SCORE = /^【分值】\s*(\d+)\s*$/;
const MARKED_OPTIONS = /^【选项】\s*$/;
const BANK_NAME_LINE = /^题库名称\s*[:：]\s*(.+)$/;

function normalizeType(raw: string | null | undefined): QuestionBankQuestionType | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replaceAll(/\s+/g, "");
  return TYPE_ALIASES[key] ?? TYPE_ALIASES[raw.trim()] ?? null;
}

function parseAnswerTokens(raw: string): string[] {
  return raw
    .split(/[,，;；、|/]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseChoiceAnswers(raw: string): string[] {
  return parseAnswerTokens(raw)
    .flatMap((token) => {
      if (/^[A-Ha-h]+$/.test(token) && token.length > 1) {
        return token.split("");
      }
      return [token];
    })
    .map((token) => token.toUpperCase())
    .filter((token) => /^[A-H]$/.test(token));
}

export function createLocalId() {
  return randomUUID();
}

export function createFragment(text: string, page?: number): SourceFragment {
  return {
    id: createLocalId(),
    text,
    page,
  };
}

type WorkingQuestion = {
  number: number | null;
  type: QuestionBankQuestionType | null;
  promptParts: string[];
  options: Array<{ label: string; text: string }>;
  answerRaw: string | null;
  score: number | null;
  snippetLines: string[];
  fragmentIds: string[];
};

function emptyWorking(number: number | null = null): WorkingQuestion {
  return {
    number,
    type: null,
    promptParts: [],
    options: [],
    answerRaw: null,
    score: null,
    snippetLines: [],
    fragmentIds: [],
  };
}

function finalizeQuestion(
  working: WorkingQuestion,
  sequence: number,
  mode: ImportParseMode,
  warnings: ImportWarning[],
): DraftQuestion | null {
  if (
    !working.promptParts.length &&
    !working.options.length &&
    working.answerRaw === null &&
    working.score === null
  ) {
    return null;
  }

  const prompt = working.promptParts.join(" ").trim() || working.snippetLines.join(" ").trim();
  const reviewReasons: string[] = [];
  let type = working.type;
  let needsReview = false;

  if (!prompt) {
    reviewReasons.push("缺少题干");
    needsReview = true;
  }
  if (!type) {
    if (working.options.length >= 2) {
      type = QuestionBankQuestionType.SINGLE_CHOICE;
      reviewReasons.push("题型未标明，暂按单选题待复核");
      needsReview = true;
    } else if (/_{2,}|（\s*）|\(\s*\)|____/.test(prompt)) {
      type = QuestionBankQuestionType.FILL_BLANK;
    } else {
      reviewReasons.push("无法识别题型");
      needsReview = true;
    }
  }

  const options = working.options.map((option) => ({
    label: option.label.toUpperCase(),
    text: option.text.trim(),
    isCorrect: null as boolean | null,
  }));

  const blanks: DraftQuestion["blanks"] = [];
  let score = working.score;

  if (type === QuestionBankQuestionType.FILL_BLANK) {
    const answers = working.answerRaw ? parseAnswerTokens(working.answerRaw) : [];
    if (!answers.length) {
      reviewReasons.push("填空题缺少答案");
      needsReview = true;
    }
    blanks.push({ blankIndex: 0, acceptableAnswers: answers });
  } else if (
    type === QuestionBankQuestionType.SINGLE_CHOICE ||
    type === QuestionBankQuestionType.MULTIPLE_CHOICE
  ) {
    if (options.length < 2) {
      reviewReasons.push("选择题选项不足");
      needsReview = true;
    }
    const answerLabels = working.answerRaw ? parseChoiceAnswers(working.answerRaw) : [];
    if (!answerLabels.length) {
      reviewReasons.push("缺少答案");
      needsReview = true;
      for (const option of options) option.isCorrect = null;
    } else {
      for (const option of options) {
        option.isCorrect = answerLabels.includes(option.label);
      }
      const correctCount = options.filter((option) => option.isCorrect).length;
      if (type === QuestionBankQuestionType.SINGLE_CHOICE && correctCount !== 1) {
        reviewReasons.push("单选题正确答案数量异常");
        needsReview = true;
      }
      if (type === QuestionBankQuestionType.MULTIPLE_CHOICE && correctCount < 2) {
        // If only one label provided but type is multi, still mark but require review
        if (correctCount === 1) {
          reviewReasons.push("多选题仅识别到一个答案，需复核");
          needsReview = true;
        } else {
          reviewReasons.push("多选题缺少有效答案");
          needsReview = true;
        }
      }
    }
  }

  if (score === null || !Number.isInteger(score) || score <= 0) {
    if (mode === "TEMPLATE") {
      reviewReasons.push("缺少有效分值");
      needsReview = true;
    } else {
      score = score && score > 0 ? score : null;
      if (score === null) {
        reviewReasons.push("分值不确定");
        needsReview = true;
      }
    }
  }

  if (mode === "BEST_EFFORT" && reviewReasons.length === 0 && working.answerRaw === null) {
    // still force review for best-effort certainty
  }

  for (const reason of reviewReasons) {
    warnings.push({
      code: "NEEDS_REVIEW",
      message: reason,
      questionIndex: sequence - 1,
    });
  }

  return {
    localId: createLocalId(),
    sequence,
    type,
    prompt,
    score,
    options,
    blanks,
    needsReview: needsReview || reviewReasons.length > 0,
    reviewReasons,
    sourceFragmentIds: working.fragmentIds,
    originalSnippet: working.snippetLines.join("\n").slice(0, 2000),
  };
}

export function recognizeStructure(input: {
  bankName?: string;
  lines: string[];
  mode: ImportParseMode;
  pageByLine?: Array<number | undefined>;
}): {
  bankName: string;
  questions: DraftQuestion[];
  sourceFragments: SourceFragment[];
  warnings: ImportWarning[];
} {
  const warnings: ImportWarning[] = [];
  const sourceFragments: SourceFragment[] = [];
  const questions: DraftQuestion[] = [];
  let bankName = input.bankName?.trim() || "导入题库";
  let working = emptyWorking();
  let sequence = 1;
  let lastNumber: number | null = null;

  const pushWorking = () => {
    const finalized = finalizeQuestion(working, sequence, input.mode, warnings);
    if (finalized) {
      if (working.number !== null && lastNumber !== null && working.number !== lastNumber + 1) {
        warnings.push({
          code: "QUESTION_NUMBER_GAP",
          message: `题号不连续：上一题 ${lastNumber}，当前题 ${working.number}`,
          questionIndex: sequence - 1,
        });
        finalized.needsReview = true;
        finalized.reviewReasons.push("题号不连续");
      }
      if (working.number !== null) lastNumber = working.number;
      questions.push(finalized);
      sequence += 1;
    }
    working = emptyWorking();
  };

  for (let index = 0; index < input.lines.length; index += 1) {
    const raw = input.lines[index]!.replace(/\u00a0/g, " ").trim();
    if (!raw) continue;

    const page = input.pageByLine?.[index];
    const fragment = createFragment(raw, page);
    sourceFragments.push(fragment);

    const bankMatch = raw.match(BANK_NAME_LINE);
    if (bankMatch) {
      bankName = bankMatch[1]!.trim();
      continue;
    }

    if (MARKED_NUMBER.test(raw) || NUMBER_LINE.test(raw)) {
      const marked = raw.match(MARKED_NUMBER);
      const numbered = raw.match(NUMBER_LINE);
      const number = Number(marked?.[1] ?? numbered?.[1]);
      if (working.promptParts.length || working.options.length || working.answerRaw) {
        pushWorking();
      }
      working = emptyWorking(Number.isFinite(number) ? number : null);
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      const rest = marked ? "" : (numbered?.[2] ?? "").trim();
      if (rest) {
        const typeHint = rest.match(/^\[(SINGLE|MULTIPLE|FILL|单选|多选|填空)\]\s*(.*)$/i);
        if (typeHint) {
          working.type = normalizeType(typeHint[1]);
          if (typeHint[2]) working.promptParts.push(typeHint[2].trim());
        } else {
          working.promptParts.push(rest);
        }
      }
      continue;
    }

    if (MARKED_TYPE.test(raw) || TYPE_LINE.test(raw)) {
      const value = (raw.match(MARKED_TYPE)?.[1] ?? raw.match(TYPE_LINE)?.[1] ?? "").trim();
      working.type = normalizeType(value);
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    if (MARKED_PROMPT.test(raw) || PROMPT_LINE.test(raw)) {
      const value = (raw.match(MARKED_PROMPT)?.[1] ?? raw.match(PROMPT_LINE)?.[1] ?? "").trim();
      if (value) working.promptParts.push(value);
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    if (MARKED_OPTIONS.test(raw)) {
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    const optionMatch = raw.match(OPTION_LINE);
    if (optionMatch) {
      working.options.push({ label: optionMatch[1]!.toUpperCase(), text: optionMatch[2]!.trim() });
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    if (MARKED_ANSWER.test(raw) || ANSWER_LINE.test(raw)) {
      const answerMatch = raw.match(ANSWER_LINE);
      working.answerRaw = (
        raw.match(MARKED_ANSWER)?.[1] ?? answerMatch?.[1] ?? answerMatch?.[2] ?? ""
      ).trim();
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    if (MARKED_SCORE.test(raw) || SCORE_LINE.test(raw)) {
      working.score = Number(raw.match(MARKED_SCORE)?.[1] ?? raw.match(SCORE_LINE)?.[1]);
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    // Continuation / wrapped option text
    if (working.options.length && !OPTION_LINE.test(raw) && !ANSWER_LINE.test(raw)) {
      const last = working.options[working.options.length - 1]!;
      last.text = `${last.text} ${raw}`.trim();
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
      continue;
    }

    if (working.number !== null || working.promptParts.length) {
      working.promptParts.push(raw);
      working.snippetLines.push(raw);
      working.fragmentIds.push(fragment.id);
    }
  }

  pushWorking();

  if (!questions.length) {
    warnings.push({ code: "NO_QUESTIONS", message: "未能识别任何题目" });
  }

  return { bankName, questions, sourceFragments, warnings };
}

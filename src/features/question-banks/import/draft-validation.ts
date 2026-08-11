import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { QuestionBankImportError } from "@/features/question-banks/import/import-errors";
import type {
  DraftQuestion,
  DraftQuestionInput,
} from "@/features/question-banks/import/import-types";

const MAX_IMPORT_QUESTIONS = 500;

function structuralIssues(question: DraftQuestionInput): string[] {
  const issues: string[] = [];
  if (!question.type) issues.push("缺少题型");
  if (!question.prompt.trim()) issues.push("缺少题干");
  if (!Number.isInteger(question.score) || Number(question.score) <= 0) {
    issues.push("缺少有效分值");
  }

  if (
    question.type === QuestionBankQuestionType.SINGLE_CHOICE ||
    question.type === QuestionBankQuestionType.MULTIPLE_CHOICE
  ) {
    if (question.options.length < 2) issues.push("选择题选项不足");
    const labels = question.options.map((option) => option.label.trim().toUpperCase());
    if (labels.some((label) => !/^[A-H]$/.test(label))) issues.push("选项标签无效");
    if (new Set(labels).size !== labels.length) issues.push("选项标签重复");
    if (question.options.some((option) => !option.text.trim())) issues.push("选项内容不能为空");
    if (question.options.some((option) => option.isCorrect === null)) issues.push("答案未确认");
    const correctCount = question.options.filter((option) => option.isCorrect === true).length;
    if (question.type === QuestionBankQuestionType.SINGLE_CHOICE && correctCount !== 1) {
      issues.push("单选题必须且只能有一个正确答案");
    }
    if (question.type === QuestionBankQuestionType.MULTIPLE_CHOICE && correctCount < 2) {
      issues.push("多选题至少需要两个正确答案");
    }
  }

  if (question.type === QuestionBankQuestionType.FILL_BLANK) {
    if (!question.blanks.length) issues.push("填空题至少需要一个空格");
    const indexes = question.blanks.map((blank) => blank.blankIndex);
    if (
      new Set(indexes).size !== indexes.length ||
      [...indexes].sort((left, right) => left - right).some((value, index) => value !== index)
    ) {
      issues.push("填空序号必须从 0 连续排列");
    }
    if (
      question.blanks.some(
        (blank) => !blank.acceptableAnswers.some((answer) => answer.trim().length > 0),
      )
    ) {
      issues.push("每个空格至少需要一个可接受答案");
    }
  }
  return [...new Set(issues)];
}

function normalizeQuestion(
  input: DraftQuestionInput,
  sequence: number,
  original?: DraftQuestion,
): DraftQuestion {
  const issues = structuralIssues(input);
  const parserReviewPending = Boolean(original?.needsReview) && input.reviewConfirmed !== true;
  const needsReview = parserReviewPending || issues.length > 0;
  const parserReasons = parserReviewPending
    ? original?.reviewReasons.length
      ? original.reviewReasons
      : ["需要人工复核"]
    : [];
  const { reviewConfirmed: _reviewConfirmed, ...question } = input;
  void _reviewConfirmed;
  return {
    ...question,
    sequence,
    prompt: question.prompt.trim(),
    options: question.options.map((option) => ({
      label: option.label.trim().toUpperCase(),
      text: option.text.trim(),
      isCorrect: option.isCorrect,
    })),
    blanks: question.blanks.map((blank, blankIndex) => ({
      blankIndex,
      acceptableAnswers: [...new Set(blank.acceptableAnswers.map((answer) => answer.trim()).filter(Boolean))],
    })),
    needsReview,
    reviewReasons: [...new Set([...parserReasons, ...issues])],
  };
}

export function normalizeImportDraftQuestions(
  inputs: DraftQuestionInput[],
  originals: DraftQuestion[],
): DraftQuestion[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_IMPORT_QUESTIONS) {
    throw new QuestionBankImportError("导入题目数量无效", "INVALID_DRAFT");
  }
  const ids = inputs.map((question) => question.localId).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw new QuestionBankImportError("导入草稿包含重复题目", "INVALID_DRAFT");
  }
  const originalById = new Map(originals.map((question) => [question.localId, question]));
  return inputs.map((question, index) =>
    normalizeQuestion(question, index + 1, originalById.get(question.localId)),
  );
}

export function assertImportDraftReady(questions: DraftQuestion[]) {
  if (!questions.length) {
    throw new QuestionBankImportError("没有可确认的题目", "EMPTY_DRAFT");
  }
  for (const [index, question] of questions.entries()) {
    if (question.needsReview) {
      throw new QuestionBankImportError(
        `第 ${index + 1} 题仍标记为需要复核，请先修正并确认已核对`,
        "NEEDS_REVIEW",
      );
    }
    const issues = structuralIssues(question);
    if (issues.length) {
      throw new QuestionBankImportError(
        `第 ${index + 1} 题无效：${issues.join("；")}`,
        issues.some((issue) => issue.includes("答案")) ? "NEEDS_REVIEW" : "INVALID_DRAFT",
      );
    }
  }
}

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  QuestionBankQuestionType,
  QuestionBankStatus,
} from "@/generated/prisma/enums";
import { ExamTaskError } from "@/features/exam-tasks/errors";
import type {
  ExamPaperSnapshotPayload,
  SnapshotQuestion,
} from "@/features/exam-tasks/dto";

type Db = PrismaClient | Prisma.TransactionClient;

const questionDeepInclude = {
  options: { orderBy: { sortOrder: "asc" as const } },
  blankAnswers: { orderBy: { blankIndex: "asc" as const } },
} satisfies Prisma.QuestionBankQuestionInclude;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function assertEnabledQuestionValid(question: {
  id: string;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: Array<{ label: string; text: string; isCorrect: boolean }>;
  blankAnswers: Array<{ blankIndex: number; acceptableAnswers: unknown }>;
}): void {
  if (!question.prompt.trim()) {
    throw new ExamTaskError("题库存在空题干，无法发布", "BANK_NOT_SELECTABLE");
  }
  if (!Number.isInteger(question.score) || question.score <= 0) {
    throw new ExamTaskError("题库存在无效分值，无法发布", "BANK_NOT_SELECTABLE");
  }

  if (
    question.type === QuestionBankQuestionType.SINGLE_CHOICE ||
    question.type === QuestionBankQuestionType.MULTIPLE_CHOICE
  ) {
    if (question.options.length < 2) {
      throw new ExamTaskError("选择题选项不足，无法发布", "BANK_NOT_SELECTABLE");
    }
    const correctCount = question.options.filter((option) => option.isCorrect).length;
    if (question.type === QuestionBankQuestionType.SINGLE_CHOICE && correctCount !== 1) {
      throw new ExamTaskError("单选题必须恰好一个正确答案", "BANK_NOT_SELECTABLE");
    }
    if (question.type === QuestionBankQuestionType.MULTIPLE_CHOICE && correctCount < 2) {
      throw new ExamTaskError("多选题至少两个正确答案", "BANK_NOT_SELECTABLE");
    }
    return;
  }

  if (question.type === QuestionBankQuestionType.FILL_BLANK) {
    if (!question.blankAnswers.length) {
      throw new ExamTaskError("填空题缺少空格答案，无法发布", "BANK_NOT_SELECTABLE");
    }
    for (const blank of question.blankAnswers) {
      const answers = asStringArray(blank.acceptableAnswers).filter((item) => item.trim());
      if (!answers.length) {
        throw new ExamTaskError("填空题存在空答案，无法发布", "BANK_NOT_SELECTABLE");
      }
    }
  }
}

export async function buildExamPaperSnapshotPayload(
  db: Db,
  questionBankId: string,
  passingScore: number,
): Promise<ExamPaperSnapshotPayload> {
  const bank = await db.questionBank.findFirst({
    where: { id: questionBankId, deletedAt: null },
    include: {
      questions: {
        where: { enabled: true },
        orderBy: { sequence: "asc" },
        include: questionDeepInclude,
      },
    },
  });

  if (!bank) {
    throw new ExamTaskError("题库不存在或已删除", "NOT_FOUND");
  }
  if (bank.status !== QuestionBankStatus.ENABLED) {
    throw new ExamTaskError("只能选择已启用的题库", "BANK_NOT_SELECTABLE");
  }
  if (!bank.questions.length) {
    throw new ExamTaskError("题库没有启用题目，无法发布", "BANK_NOT_SELECTABLE");
  }

  for (const question of bank.questions) {
    assertEnabledQuestionValid(question);
  }

  const questions: SnapshotQuestion[] = bank.questions.map((question) => ({
    id: question.id,
    sequence: question.sequence,
    type: question.type,
    prompt: question.prompt,
    score: question.score,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      text: option.text,
      isCorrect: option.isCorrect,
      sortOrder: option.sortOrder,
    })),
    blanks: question.blankAnswers.map((blank) => ({
      id: blank.id,
      blankIndex: blank.blankIndex,
      acceptableAnswers: asStringArray(blank.acceptableAnswers),
      sortOrder: blank.sortOrder,
    })),
  }));

  const totalScore = questions.reduce((sum, question) => sum + question.score, 0);
  if (totalScore !== 100) {
    throw new ExamTaskError(
      `启用题目总分必须为 100，当前为 ${totalScore}`,
      "BANK_NOT_SELECTABLE",
    );
  }
  if (bank.enabledScore !== 100) {
    throw new ExamTaskError(
      `题库启用总分必须为 100，当前为 ${bank.enabledScore}`,
      "BANK_NOT_SELECTABLE",
    );
  }

  return {
    questionBankId: bank.id,
    questionBankName: bank.name,
    questionBankVersion: bank.versionNumber,
    questions,
    questionCount: questions.length,
    totalScore,
    passingScore,
  };
}

export async function listSelectableQuestionBanks(db: Db) {
  const candidates = await db.questionBank.findMany({
    where: {
      deletedAt: null,
      status: QuestionBankStatus.ENABLED,
      enabledScore: 100,
    },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      isDefault: true,
      status: true,
      versionNumber: true,
      passingScore: true,
      enabledScore: true,
      questionCount: true,
      updatedAt: true,
    },
  });
  const selectable = [];
  for (const bank of candidates) {
    try {
      await buildExamPaperSnapshotPayload(db, bank.id, bank.passingScore);
      selectable.push(bank);
    } catch (error) {
      if (!(error instanceof ExamTaskError) || error.code !== "BANK_NOT_SELECTABLE") {
        throw error;
      }
    }
  }
  return selectable;
}

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { normalizeAnswer } from "@/features/question-banks/answer-normalize";
import { QuestionBankQuestionError } from "@/features/question-banks/errors";
import { requireQuestionBankAdmin } from "@/features/question-banks/permissions";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export { QuestionBankQuestionError };

export type ChoiceOptionInput = {
  label: string;
  text: string;
  isCorrect: boolean;
};

export type BlankInput = {
  blankIndex: number;
  acceptableAnswers: string[];
};

export type QuestionBankQuestionInput = {
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  enabled: boolean;
  options?: ChoiceOptionInput[];
  blanks?: BlankInput[];
};

const questionInclude = {
  options: { orderBy: { sortOrder: "asc" as const } },
  blankAnswers: { orderBy: { blankIndex: "asc" as const } },
} satisfies Prisma.QuestionBankQuestionInclude;

function normalizeOptionLabel(label: string): string {
  return label.trim().toUpperCase();
}

function normalizeAcceptableAnswers(answers: string[]): string[] {
  const cleaned = answers
    .map((answer) => String(answer).trim())
    .filter((answer) => answer.length > 0);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const answer of cleaned) {
    const key = normalizeAnswer(answer);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(answer);
  }
  return unique;
}

function validateQuestionInput(input: QuestionBankQuestionInput) {
  if (!input.prompt.trim()) {
    throw new QuestionBankQuestionError("题干不能为空");
  }
  if (!Number.isInteger(input.score) || input.score <= 0) {
    throw new QuestionBankQuestionError("分值必须为正整数");
  }

  if (
    input.type === QuestionBankQuestionType.SINGLE_CHOICE ||
    input.type === QuestionBankQuestionType.MULTIPLE_CHOICE
  ) {
    const options = input.options ?? [];
    if (options.length < 2) {
      throw new QuestionBankQuestionError("选择题至少需要两个选项");
    }
    const labels = options.map((option) => normalizeOptionLabel(option.label));
    if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
      throw new QuestionBankQuestionError("选项标签不能为空且不能重复");
    }
    if (options.some((option) => !option.text.trim())) {
      throw new QuestionBankQuestionError("选项内容不能为空");
    }
    const correctCount = options.filter((option) => option.isCorrect).length;
    if (input.type === QuestionBankQuestionType.SINGLE_CHOICE && correctCount !== 1) {
      throw new QuestionBankQuestionError("单选题必须恰好有一个正确答案");
    }
    if (input.type === QuestionBankQuestionType.MULTIPLE_CHOICE && correctCount < 2) {
      throw new QuestionBankQuestionError("多选题至少需要两个正确答案");
    }
    return {
      options: options.map((option, index) => ({
        label: labels[index]!,
        text: option.text.trim(),
        isCorrect: option.isCorrect,
        sortOrder: index,
      })),
      blanks: [] as Array<{ blankIndex: number; acceptableAnswers: string[]; sortOrder: number }>,
    };
  }

  if (input.type === QuestionBankQuestionType.FILL_BLANK) {
    const blanks = input.blanks ?? [];
    if (!blanks.length) {
      throw new QuestionBankQuestionError("填空题至少一个空格");
    }
    const indices = blanks.map((blank) => blank.blankIndex);
    if (indices.some((index) => !Number.isInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
      throw new QuestionBankQuestionError("空格序号必须为不重复的非负整数");
    }
    const normalizedBlanks = blanks
      .slice()
      .sort((left, right) => left.blankIndex - right.blankIndex)
      .map((blank, order) => {
        const acceptableAnswers = normalizeAcceptableAnswers(blank.acceptableAnswers ?? []);
        if (!acceptableAnswers.length) {
          throw new QuestionBankQuestionError("每个空格至少一个可接受答案");
        }
        return {
          blankIndex: blank.blankIndex,
          acceptableAnswers,
          sortOrder: order,
        };
      });
    return { options: [], blanks: normalizedBlanks };
  }

  throw new QuestionBankQuestionError("不支持的题型");
}

export async function refreshQuestionBankTotals(db: Db | Tx, questionBankId: string) {
  const [questionCount, enabledAggregate] = await Promise.all([
    db.questionBankQuestion.count({ where: { questionBankId } }),
    db.questionBankQuestion.aggregate({
      where: { questionBankId, enabled: true },
      _sum: { score: true },
    }),
  ]);
  const enabledScore = enabledAggregate._sum.score ?? 0;
  await db.questionBank.update({
    where: { id: questionBankId },
    data: { questionCount, enabledScore },
  });
  return { questionCount, enabledScore };
}

async function requireActiveBank(db: Db | Tx, questionBankId: string) {
  const bank = await db.questionBank.findFirst({
    where: { id: questionBankId, deletedAt: null },
  });
  if (!bank) {
    throw new QuestionBankQuestionError("题库不存在或已删除", "NOT_FOUND");
  }
  return bank;
}

async function nextSequence(db: Db | Tx, questionBankId: string) {
  const latest = await db.questionBankQuestion.findFirst({
    where: { questionBankId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return (latest?.sequence ?? 0) + 1;
}

async function replaceQuestionChildren(
  transaction: Tx,
  questionId: string,
  validated: ReturnType<typeof validateQuestionInput>,
) {
  await transaction.questionBankOption.deleteMany({ where: { questionId } });
  await transaction.questionBankBlankAnswer.deleteMany({ where: { questionId } });
  if (validated.options.length) {
    await transaction.questionBankOption.createMany({
      data: validated.options.map((option) => ({
        questionId,
        label: option.label,
        text: option.text,
        isCorrect: option.isCorrect,
        sortOrder: option.sortOrder,
      })),
    });
  }
  if (validated.blanks.length) {
    await transaction.questionBankBlankAnswer.createMany({
      data: validated.blanks.map((blank) => ({
        questionId,
        blankIndex: blank.blankIndex,
        acceptableAnswers: blank.acceptableAnswers as Prisma.InputJsonValue,
        sortOrder: blank.sortOrder,
      })),
    });
  }
}

export async function createQuestionBankQuestion(
  db: Db,
  questionBankId: string,
  input: QuestionBankQuestionInput,
  actorId: string,
) {
  const validated = validateQuestionInput(input);
  return db.$transaction(async (transaction) => {
    await requireQuestionBankAdmin(transaction, actorId);
    await requireActiveBank(transaction, questionBankId);
    const sequence = await nextSequence(transaction, questionBankId);
    const question = await transaction.questionBankQuestion.create({
      data: {
        questionBankId,
        sequence,
        type: input.type,
        prompt: input.prompt.trim(),
        score: input.score,
        enabled: input.enabled,
      },
    });
    await replaceQuestionChildren(transaction, question.id, validated);
    await refreshQuestionBankTotals(transaction, questionBankId);
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_QUESTION_CREATE",
      targetType: "QUESTION_BANK_QUESTION",
      targetId: question.id,
      result: "SUCCESS",
      metadata: { questionBankId, sequence, type: input.type },
    });
    return transaction.questionBankQuestion.findUniqueOrThrow({
      where: { id: question.id },
      include: questionInclude,
    });
  });
}

export async function updateQuestionBankQuestion(
  db: Db,
  questionId: string,
  input: QuestionBankQuestionInput,
  actorId: string,
  expectedQuestionBankId?: string,
) {
  const validated = validateQuestionInput(input);
  return db.$transaction(async (transaction) => {
    await requireQuestionBankAdmin(transaction, actorId);
    const existing = await transaction.questionBankQuestion.findUnique({
      where: { id: questionId },
    });
    if (!existing) {
      throw new QuestionBankQuestionError("题目不存在", "NOT_FOUND");
    }
    if (expectedQuestionBankId && existing.questionBankId !== expectedQuestionBankId) {
      throw new QuestionBankQuestionError("题目不属于指定题库", "NOT_FOUND");
    }
    await requireActiveBank(transaction, existing.questionBankId);
    await transaction.questionBankQuestion.update({
      where: { id: questionId },
      data: {
        type: input.type,
        prompt: input.prompt.trim(),
        score: input.score,
        enabled: input.enabled,
      },
    });
    await replaceQuestionChildren(transaction, questionId, validated);
    await refreshQuestionBankTotals(transaction, existing.questionBankId);
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_QUESTION_UPDATE",
      targetType: "QUESTION_BANK_QUESTION",
      targetId: questionId,
      result: "SUCCESS",
      metadata: { questionBankId: existing.questionBankId, type: input.type },
    });
    return transaction.questionBankQuestion.findUniqueOrThrow({
      where: { id: questionId },
      include: questionInclude,
    });
  });
}

export async function setQuestionBankQuestionEnabled(
  db: Db,
  questionId: string,
  enabled: boolean,
  actorId: string,
  expectedQuestionBankId?: string,
) {
  return db.$transaction(async (transaction) => {
    await requireQuestionBankAdmin(transaction, actorId);
    const existing = await transaction.questionBankQuestion.findUnique({
      where: { id: questionId },
    });
    if (!existing) {
      throw new QuestionBankQuestionError("题目不存在", "NOT_FOUND");
    }
    if (expectedQuestionBankId && existing.questionBankId !== expectedQuestionBankId) {
      throw new QuestionBankQuestionError("题目不属于指定题库", "NOT_FOUND");
    }
    await requireActiveBank(transaction, existing.questionBankId);
    const question = await transaction.questionBankQuestion.update({
      where: { id: questionId },
      data: { enabled },
      include: questionInclude,
    });
    await refreshQuestionBankTotals(transaction, existing.questionBankId);
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_QUESTION_ENABLE_CHANGE",
      targetType: "QUESTION_BANK_QUESTION",
      targetId: questionId,
      result: "SUCCESS",
      metadata: { enabled, questionBankId: existing.questionBankId },
    });
    return question;
  });
}

export async function deleteQuestionBankQuestion(
  db: Db,
  questionId: string,
  actorId: string,
  expectedQuestionBankId?: string,
) {
  return db.$transaction(async (transaction) => {
    await requireQuestionBankAdmin(transaction, actorId);
    const existing = await transaction.questionBankQuestion.findUnique({
      where: { id: questionId },
    });
    if (!existing) {
      throw new QuestionBankQuestionError("题目不存在", "NOT_FOUND");
    }
    if (expectedQuestionBankId && existing.questionBankId !== expectedQuestionBankId) {
      throw new QuestionBankQuestionError("题目不属于指定题库", "NOT_FOUND");
    }
    await requireActiveBank(transaction, existing.questionBankId);
    await transaction.questionBankQuestion.delete({ where: { id: questionId } });

    const remaining = await transaction.questionBankQuestion.findMany({
      where: { questionBankId: existing.questionBankId },
      orderBy: { sequence: "asc" },
      select: { id: true },
    });
    for (const [index, item] of remaining.entries()) {
      await transaction.questionBankQuestion.update({
        where: { id: item.id },
        data: { sequence: index + 1 },
      });
    }
    await refreshQuestionBankTotals(transaction, existing.questionBankId);
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_QUESTION_DELETE",
      targetType: "QUESTION_BANK_QUESTION",
      targetId: questionId,
      result: "SUCCESS",
      metadata: { questionBankId: existing.questionBankId },
    });
    return { questionBankId: existing.questionBankId };
  });
}

export async function reorderQuestionBankQuestions(
  db: Db,
  questionBankId: string,
  orderedQuestionIds: string[],
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    await requireQuestionBankAdmin(transaction, actorId);
    await requireActiveBank(transaction, questionBankId);
    const existing = await transaction.questionBankQuestion.findMany({
      where: { questionBankId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((item) => item.id));
    if (
      orderedQuestionIds.length !== existing.length ||
      orderedQuestionIds.some((id) => !existingIds.has(id)) ||
      new Set(orderedQuestionIds).size !== orderedQuestionIds.length
    ) {
      throw new QuestionBankQuestionError("题目排序列表与题库题目不一致");
    }

    // Two-phase update to avoid unique (questionBankId, sequence) collisions.
    for (const [index, id] of orderedQuestionIds.entries()) {
      await transaction.questionBankQuestion.update({
        where: { id },
        data: { sequence: -(index + 1) },
      });
    }
    for (const [index, id] of orderedQuestionIds.entries()) {
      await transaction.questionBankQuestion.update({
        where: { id },
        data: { sequence: index + 1 },
      });
    }
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_QUESTION_REORDER",
      targetType: "QUESTION_BANK",
      targetId: questionBankId,
      result: "SUCCESS",
      metadata: { orderedQuestionIds },
    });
    return transaction.questionBankQuestion.findMany({
      where: { questionBankId },
      orderBy: { sequence: "asc" },
      include: questionInclude,
    });
  });
}

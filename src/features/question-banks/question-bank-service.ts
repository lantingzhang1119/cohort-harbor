import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  QuestionBankSource,
  QuestionBankStatus,
} from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { QuestionBankError } from "@/features/question-banks/errors";
import { requireQuestionBankAdmin } from "@/features/question-banks/permissions";
import { refreshQuestionBankTotals } from "@/features/question-banks/question-service";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export { QuestionBankError };

const bankListOrder: Prisma.QuestionBankOrderByWithRelationInput[] = [
  { isDefault: "desc" },
  { updatedAt: "desc" },
  { id: "asc" },
];

const questionDeepInclude = {
  options: { orderBy: { sortOrder: "asc" as const } },
  blankAnswers: { orderBy: { blankIndex: "asc" as const } },
} satisfies Prisma.QuestionBankQuestionInclude;

async function requireActiveBank(db: Db | Tx, bankId: string) {
  const bank = await db.questionBank.findFirst({
    where: { id: bankId, deletedAt: null },
  });
  if (!bank) {
    throw new QuestionBankError("题库不存在或已删除", "NOT_FOUND");
  }
  return bank;
}

export async function listQuestionBanks(db: Db) {
  return db.questionBank.findMany({
    where: { deletedAt: null },
    orderBy: bankListOrder,
  });
}

export async function getQuestionBankDetail(db: Db, bankId: string) {
  const bank = await db.questionBank.findFirst({
    where: { id: bankId, deletedAt: null },
    include: {
      questions: {
        orderBy: { sequence: "asc" },
        include: questionDeepInclude,
      },
    },
  });
  if (!bank) {
    throw new QuestionBankError("题库不存在或已删除", "NOT_FOUND");
  }
  return bank;
}

export async function createBlankQuestionBank(
  db: Db,
  input: { name: string; description?: string | null; actorId: string },
) {
  const name = input.name.trim();
  if (!name) {
    throw new QuestionBankError("题库名称不能为空");
  }
  return db.$transaction(async (transaction) => {
    const { snapshot } = await requireQuestionBankAdmin(transaction, input.actorId);
    const bank = await transaction.questionBank.create({
      data: {
        name,
        description: input.description?.trim() || null,
        status: QuestionBankStatus.DRAFT,
        source: QuestionBankSource.ONLINE,
        isDefault: false,
        versionNumber: 1,
        questionCount: 0,
        enabledScore: 0,
        createdById: input.actorId,
        createdBySnapshot: snapshot,
        updatedById: input.actorId,
        updatedBySnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId: input.actorId,
      action: "QUESTION_BANK_CREATE",
      targetType: "QUESTION_BANK",
      targetId: bank.id,
      result: "SUCCESS",
      metadata: { name: bank.name, source: bank.source },
    });
    return bank;
  });
}

export async function updateQuestionBankMeta(
  db: Db,
  bankId: string,
  input: { name?: string; description?: string | null; actorId: string },
) {
  return db.$transaction(async (transaction) => {
    const existing = await requireActiveBank(transaction, bankId);
    const { snapshot } = await requireQuestionBankAdmin(transaction, input.actorId);
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) {
      throw new QuestionBankError("题库名称不能为空");
    }
    const bank = await transaction.questionBank.update({
      where: { id: bankId },
      data: {
        name,
        description:
          input.description === undefined
            ? existing.description
            : input.description?.trim() || null,
        updatedById: input.actorId,
        updatedBySnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId: input.actorId,
      action: "QUESTION_BANK_UPDATE",
      targetType: "QUESTION_BANK",
      targetId: bankId,
      result: "SUCCESS",
      metadata: { name: bank.name },
    });
    return bank;
  });
}

export async function setDefaultQuestionBank(db: Db, bankId: string, actorId: string) {
  return db.$transaction(async (transaction) => {
    const bank = await requireActiveBank(transaction, bankId);
    const { snapshot } = await requireQuestionBankAdmin(transaction, actorId);
    const totals = await refreshQuestionBankTotals(transaction, bankId);
    if (bank.status !== QuestionBankStatus.ENABLED || totals.enabledScore !== 100) {
      throw new QuestionBankError(
        "只有已启用且启用题目总分为 100 的题库才能设为默认",
        "BANK_NOT_READY",
      );
    }
    await transaction.questionBank.updateMany({
      where: { isDefault: true, deletedAt: null, id: { not: bankId } },
      data: {
        isDefault: false,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    const updated = await transaction.questionBank.update({
      where: { id: bankId },
      data: {
        isDefault: true,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_SET_DEFAULT",
      targetType: "QUESTION_BANK",
      targetId: bankId,
      result: "SUCCESS",
      metadata: { previousDefaultCleared: true, name: bank.name },
    });
    return updated;
  });
}

export async function setQuestionBankStatus(
  db: Db,
  bankId: string,
  status: QuestionBankStatus,
  actorId: string,
) {
  if (!Object.values(QuestionBankStatus).includes(status)) {
    throw new QuestionBankError("题库状态无效");
  }
  return db.$transaction(async (transaction) => {
    const bank = await requireActiveBank(transaction, bankId);
    const { snapshot } = await requireQuestionBankAdmin(transaction, actorId);

    if (status === QuestionBankStatus.ENABLED) {
      const totals = await refreshQuestionBankTotals(transaction, bankId);
      if (totals.enabledScore !== 100) {
        throw new QuestionBankError(
          `启用题目总分必须为 100，当前为 ${totals.enabledScore}`,
          "SCORE_NOT_100",
        );
      }
    }

    if (
      bank.isDefault &&
      (status === QuestionBankStatus.DISABLED || status === QuestionBankStatus.DRAFT)
    ) {
      throw new QuestionBankError(
        "默认题库不能在没有替代默认题库的情况下被停用",
        "DEFAULT_PROTECTED",
      );
    }

    const updated = await transaction.questionBank.update({
      where: { id: bankId },
      data: {
        status,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
        ...(status === QuestionBankStatus.ENABLED && bank.status !== QuestionBankStatus.ENABLED
          ? { versionNumber: { increment: 1 } }
          : {}),
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_STATUS_CHANGE",
      targetType: "QUESTION_BANK",
      targetId: bankId,
      result: "SUCCESS",
      metadata: { from: bank.status, to: status },
    });
    return updated;
  });
}

export async function softDeleteQuestionBank(db: Db, bankId: string, actorId: string) {
  return db.$transaction(async (transaction) => {
    const bank = await requireActiveBank(transaction, bankId);
    const { snapshot } = await requireQuestionBankAdmin(transaction, actorId);
    if (bank.isDefault) {
      throw new QuestionBankError(
        "默认题库不能在没有替代默认题库的情况下被删除",
        "DEFAULT_PROTECTED",
      );
    }
    const updated = await transaction.questionBank.update({
      where: { id: bankId },
      data: {
        deletedAt: new Date(),
        deletedById: actorId,
        deletedBySnapshot: snapshot,
        statusBeforeDelete: bank.status,
        isDefault: false,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_SOFT_DELETE",
      targetType: "QUESTION_BANK",
      targetId: bankId,
      result: "SUCCESS",
      metadata: { name: bank.name, statusBeforeDelete: bank.status },
    });
    return updated;
  });
}

export async function copyQuestionBank(
  db: Db,
  sourceBankId: string,
  actorId: string,
  options?: { name?: string },
) {
  return db.$transaction(async (transaction) => {
    const source = await transaction.questionBank.findFirst({
      where: { id: sourceBankId, deletedAt: null },
      include: {
        questions: {
          orderBy: { sequence: "asc" },
          include: questionDeepInclude,
        },
      },
    });
    if (!source) {
      throw new QuestionBankError("源题库不存在或已删除", "NOT_FOUND");
    }
    const { snapshot } = await requireQuestionBankAdmin(transaction, actorId);
    const name = (options?.name?.trim() || `${source.name}（副本）`).trim();
    const bank = await transaction.questionBank.create({
      data: {
        name,
        description: source.description,
        status: QuestionBankStatus.DRAFT,
        source: QuestionBankSource.ONLINE,
        isDefault: false,
        versionNumber: 1,
        passingScore: source.passingScore,
        durationMinutes: source.durationMinutes,
        randomizeQuestions: source.randomizeQuestions,
        randomizeOptions: source.randomizeOptions,
        showWrongAnswers: source.showWrongAnswers,
        questionCount: 0,
        enabledScore: 0,
        createdById: actorId,
        createdBySnapshot: snapshot,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });

    for (const question of source.questions) {
      const created = await transaction.questionBankQuestion.create({
        data: {
          questionBankId: bank.id,
          sequence: question.sequence,
          type: question.type,
          prompt: question.prompt,
          score: question.score,
          enabled: question.enabled,
        },
      });
      if (question.options.length) {
        await transaction.questionBankOption.createMany({
          data: question.options.map((option) => ({
            questionId: created.id,
            label: option.label,
            text: option.text,
            isCorrect: option.isCorrect,
            sortOrder: option.sortOrder,
          })),
        });
      }
      if (question.blankAnswers.length) {
        await transaction.questionBankBlankAnswer.createMany({
          data: question.blankAnswers.map((blank) => ({
            questionId: created.id,
            blankIndex: blank.blankIndex,
            acceptableAnswers: blank.acceptableAnswers as Prisma.InputJsonValue,
            sortOrder: blank.sortOrder,
          })),
        });
      }
    }

    await refreshQuestionBankTotals(transaction, bank.id);
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_BANK_COPY",
      targetType: "QUESTION_BANK",
      targetId: bank.id,
      result: "SUCCESS",
      metadata: { sourceBankId, name },
    });
    return transaction.questionBank.findUniqueOrThrow({ where: { id: bank.id } });
  });
}

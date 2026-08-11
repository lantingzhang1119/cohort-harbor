import type { PrismaClient } from "@/generated/prisma/client";
import { QuestionType } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

export type QuestionInput = {
  sequence: number;
  type: QuestionType;
  prompt: string;
  score: number;
  enabled: boolean;
  options: Array<{ key: string; text: string }>;
  correctKeys: string[];
};

function validateQuestion(input: QuestionInput) {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new QuestionValidationError("题号必须为正整数");
  }
  if (!input.prompt.trim()) throw new QuestionValidationError("题干不能为空");
  if (!Number.isInteger(input.score) || input.score <= 0) {
    throw new QuestionValidationError("分值必须为正整数");
  }
  const optionKeys = input.options.map((option) => option.key.trim().toUpperCase());
  if (optionKeys.length < 2 || new Set(optionKeys).size !== optionKeys.length) {
    throw new QuestionValidationError("选项至少两个且键值不能重复");
  }
  if (input.options.some((option) => !option.text.trim())) {
    throw new QuestionValidationError("选项内容不能为空");
  }
  const correctKeys = input.correctKeys.map((key) => key.trim().toUpperCase());
  if (!correctKeys.length || correctKeys.some((key) => !optionKeys.includes(key))) {
    throw new QuestionValidationError("正确答案必须来自有效选项");
  }
  if (input.type !== QuestionType.MULTIPLE && correctKeys.length !== 1) {
    throw new QuestionValidationError("单选题和判断题只能有一个正确答案");
  }
  if (input.type === QuestionType.TRUE_FALSE && input.options.length !== 2) {
    throw new QuestionValidationError("判断题必须有两个选项");
  }
  return { optionKeys, correctKeys };
}

export async function upsertQuestion(
  db: PrismaClient,
  examId: string,
  input: QuestionInput,
  actorId: string,
) {
  const normalized = validateQuestion(input);
  return db.$transaction(async (transaction) => {
    const existing = await transaction.question.findUnique({
      where: { examId_sequence: { examId, sequence: input.sequence } },
    });
    const question = existing
      ? await transaction.question.update({
          where: { id: existing.id },
          data: {
            type: input.type,
            prompt: input.prompt.trim(),
            score: input.score,
            enabled: input.enabled,
          },
        })
      : await transaction.question.create({
          data: {
            examId,
            sequence: input.sequence,
            type: input.type,
            prompt: input.prompt.trim(),
            score: input.score,
            enabled: input.enabled,
          },
        });
    await transaction.questionOption.deleteMany({ where: { questionId: question.id } });
    await transaction.questionOption.createMany({
      data: input.options.map((option, index) => {
        const key = normalized.optionKeys[index]!;
        return {
          questionId: question.id,
          optionKey: key,
          text: option.text.trim(),
          isCorrect: normalized.correctKeys.includes(key),
          sortOrder: index,
        };
      }),
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_UPSERT",
      targetType: "QUESTION",
      targetId: question.id,
      result: "SUCCESS",
      metadata: { examId, sequence: input.sequence },
    });
    return transaction.question.findUniqueOrThrow({
      where: { id: question.id },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
  });
}

export async function setQuestionEnabled(
  db: PrismaClient,
  questionId: string,
  enabled: boolean,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    const question = await transaction.question.update({
      where: { id: questionId },
      data: { enabled },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "QUESTION_ENABLE_CHANGE",
      targetType: "QUESTION",
      targetId: questionId,
      result: "SUCCESS",
      metadata: { enabled },
    });
    return question;
  });
}

export async function validateEnabledExamScore(db: PrismaClient, examId: string) {
  const aggregate = await db.question.aggregate({
    where: { examId, enabled: true },
    _sum: { score: true },
  });
  const total = aggregate._sum.score ?? 0;
  if (total !== 100) {
    throw new QuestionValidationError(`启用题目总分必须为 100，当前为 ${total}`);
  }
  return total;
}

export async function updateExamSettings(
  db: PrismaClient,
  examId: string,
  input: {
    durationMinutes: number;
    dueDaysAfterHire: number;
    watermarkOpacity: number;
    showWrongAnswers?: boolean;
  },
  actorId: string,
) {
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 40) {
    throw new QuestionValidationError("考试时长必须为 1–40 分钟");
  }
  if (!Number.isInteger(input.dueDaysAfterHire) || input.dueDaysAfterHire < 1 || input.dueDaysAfterHire > 65) {
    throw new QuestionValidationError("完成期限必须为 1–65 天");
  }
  if (input.watermarkOpacity < 0.03 || input.watermarkOpacity > 0.18) {
    throw new QuestionValidationError("水印透明度必须为 0.03–0.18");
  }
  return db.$transaction(async (transaction) => {
    const exam = await transaction.exam.update({
      where: { id: examId },
      data: {
        durationMinutes: input.durationMinutes,
        dueDaysAfterHire: input.dueDaysAfterHire,
        ...(input.showWrongAnswers === undefined
          ? {}
          : { showWrongAnswers: input.showWrongAnswers }),
      },
    });
    await transaction.systemSetting.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultExamMinutes: input.durationMinutes,
        defaultDueDays: input.dueDaysAfterHire,
        watermarkOpacity: input.watermarkOpacity,
        showWrongAnswers: input.showWrongAnswers ?? false,
      },
      update: {
        defaultExamMinutes: input.durationMinutes,
        defaultDueDays: input.dueDaysAfterHire,
        watermarkOpacity: input.watermarkOpacity,
        ...(input.showWrongAnswers === undefined
          ? {}
          : { showWrongAnswers: input.showWrongAnswers }),
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "EXAM_SETTINGS_UPDATE",
      targetType: "EXAM",
      targetId: examId,
      result: "SUCCESS",
    });
    return exam;
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QuestionBankQuestionType,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createBlankQuestionBank } from "@/features/question-banks/question-bank-service";
import {
  QuestionBankQuestionError,
  createQuestionBankQuestion,
  deleteQuestionBankQuestion,
  reorderQuestionBankQuestions,
  setQuestionBankQuestionEnabled,
  updateQuestionBankQuestion,
} from "@/features/question-banks/question-service";
import { createTestDatabase } from "../helpers/test-db";

describe("question bank question service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;
  let employeeId: string;
  let bankId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    actorId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ADMIN-QQ",
          name: "题目管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("InitialPass!23"),
        },
      })
    ).id;
    employeeId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "EMP-QQ",
          name: "普通员工",
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("InitialPass!23"),
        },
      })
    ).id;
    bankId = (await createBlankQuestionBank(testDb.db, { name: "编辑题库", actorId })).id;
  });

  afterEach(async () => testDb.cleanup());

  it("creates single-choice questions with one correct option", async () => {
    const question = await createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "单选",
      score: 5,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    expect(question.sequence).toBe(1);
    expect(question.options.filter((option) => option.isCorrect)).toHaveLength(1);
  });

  it("rejects employee writes in the domain service even when called outside a route", async () => {
    await expect(createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "越权写题",
      score: 5,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, employeeId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await testDb.db.questionBankQuestion.count({ where: { questionBankId: bankId } })).toBe(0);
  });

  it("rejects invalid question rules for each type", async () => {
    await expect(
      createQuestionBankQuestion(testDb.db, bankId, {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "坏单选",
        score: 5,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "也是", isCorrect: true },
        ],
      }, actorId),
    ).rejects.toBeInstanceOf(QuestionBankQuestionError);

    await expect(
      createQuestionBankQuestion(testDb.db, bankId, {
        type: QuestionBankQuestionType.MULTIPLE_CHOICE,
        prompt: "坏多选",
        score: 5,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }, actorId),
    ).rejects.toBeInstanceOf(QuestionBankQuestionError);

    await expect(
      createQuestionBankQuestion(testDb.db, bankId, {
        type: QuestionBankQuestionType.FILL_BLANK,
        prompt: "空填空",
        score: 5,
        enabled: true,
        blanks: [{ blankIndex: 0, acceptableAnswers: [] }],
      }, actorId),
    ).rejects.toBeInstanceOf(QuestionBankQuestionError);

    await expect(
      createQuestionBankQuestion(testDb.db, bankId, {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "零分",
        score: 0,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }, actorId),
    ).rejects.toBeInstanceOf(QuestionBankQuestionError);
  });

  it("updates, toggles, deletes and reorders questions with audit logs", async () => {
    const first = await createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "第一题",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    const second = await createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.MULTIPLE_CHOICE,
      prompt: "第二题",
      score: 30,
      enabled: true,
      options: [
        { label: "A", text: "1", isCorrect: true },
        { label: "B", text: "2", isCorrect: true },
        { label: "C", text: "3", isCorrect: false },
      ],
    }, actorId);
    const third = await createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.FILL_BLANK,
      prompt: "第三题 ____",
      score: 30,
      enabled: true,
      blanks: [{ blankIndex: 0, acceptableAnswers: ["答案", "Answer"] }],
    }, actorId);

    const updated = await updateQuestionBankQuestion(testDb.db, first.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "第一题已改",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "新对", isCorrect: true },
        { label: "B", text: "新错", isCorrect: false },
        { label: "C", text: "干扰", isCorrect: false },
      ],
    }, actorId);
    expect(updated.prompt).toBe("第一题已改");
    expect(updated.options).toHaveLength(3);

    await setQuestionBankQuestionEnabled(testDb.db, second.id, false, actorId);
    expect(
      (await testDb.db.questionBankQuestion.findUniqueOrThrow({ where: { id: second.id } })).enabled,
    ).toBe(false);

    await reorderQuestionBankQuestions(testDb.db, bankId, [third.id, first.id, second.id], actorId);
    const ordered = await testDb.db.questionBankQuestion.findMany({
      where: { questionBankId: bankId },
      orderBy: { sequence: "asc" },
    });
    expect(ordered.map((item) => item.id)).toEqual([third.id, first.id, second.id]);
    expect(ordered.map((item) => item.sequence)).toEqual([1, 2, 3]);

    await deleteQuestionBankQuestion(testDb.db, second.id, actorId);
    expect(await testDb.db.questionBankQuestion.count({ where: { questionBankId: bankId } })).toBe(2);
    const bank = await testDb.db.questionBank.findUniqueOrThrow({ where: { id: bankId } });
    expect(bank.questionCount).toBe(2);
    expect(bank.enabledScore).toBe(70);

    const actions = await testDb.db.auditLog.findMany({
      where: {
        action: {
          in: [
            "QUESTION_BANK_QUESTION_CREATE",
            "QUESTION_BANK_QUESTION_UPDATE",
            "QUESTION_BANK_QUESTION_ENABLE_CHANGE",
            "QUESTION_BANK_QUESTION_REORDER",
            "QUESTION_BANK_QUESTION_DELETE",
          ],
        },
      },
    });
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it("persists multiple acceptable answers per blank", async () => {
    const question = await createQuestionBankQuestion(testDb.db, bankId, {
      type: QuestionBankQuestionType.FILL_BLANK,
      prompt: "地点____ 分数____",
      score: 10,
      enabled: true,
      blanks: [
        { blankIndex: 0, acceptableAnswers: ["上海", "ShangHai", "SH"] },
        { blankIndex: 1, acceptableAnswers: ["80", "八十"] },
      ],
    }, actorId);
    expect(question.blankAnswers).toHaveLength(2);
    expect(question.blankAnswers[0]!.acceptableAnswers).toEqual(["上海", "ShangHai", "SH"]);
    expect(question.blankAnswers[1]!.acceptableAnswers).toEqual(["80", "八十"]);
  });
});

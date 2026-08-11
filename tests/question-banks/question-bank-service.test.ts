import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QuestionBankQuestionType,
  QuestionBankSource,
  QuestionBankStatus,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  QuestionBankError,
  copyQuestionBank,
  createBlankQuestionBank,
  listQuestionBanks,
  setDefaultQuestionBank,
  setQuestionBankStatus,
  softDeleteQuestionBank,
} from "@/features/question-banks/question-bank-service";
import {
  createQuestionBankQuestion,
  refreshQuestionBankTotals,
} from "@/features/question-banks/question-service";
import { createTestDatabase } from "../helpers/test-db";

describe("question bank service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    actorId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ADMIN-QB",
          name: "题库管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("InitialPass!23"),
        },
      })
    ).id;
  });

  afterEach(async () => testDb.cleanup());

  async function seedEnabledBank(name: string, makeDefault = false) {
    const bank = await createBlankQuestionBank(testDb.db, {
      name,
      description: `${name}描述`,
      actorId,
    });
    await createQuestionBankQuestion(testDb.db, bank.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: `${name}单选题`,
      score: 100,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    await setQuestionBankStatus(testDb.db, bank.id, QuestionBankStatus.ENABLED, actorId);
    if (makeDefault) {
      await setDefaultQuestionBank(testDb.db, bank.id, actorId);
    }
    return bank;
  }

  it("creates a blank online draft bank with zero totals", async () => {
    const bank = await createBlankQuestionBank(testDb.db, {
      name: "空白题库",
      actorId,
    });
    expect(bank).toMatchObject({
      name: "空白题库",
      status: QuestionBankStatus.DRAFT,
      source: QuestionBankSource.ONLINE,
      isDefault: false,
      questionCount: 0,
      enabledScore: 0,
      versionNumber: 1,
    });
    const logs = await testDb.db.auditLog.findMany({ where: { action: "QUESTION_BANK_CREATE" } });
    expect(logs).toHaveLength(1);
  });

  it("lists non-deleted banks with default marker and refreshed totals", async () => {
    const first = await seedEnabledBank("默认卷", true);
    await createBlankQuestionBank(testDb.db, { name: "草稿卷", actorId });
    const listed = await listQuestionBanks(testDb.db);
    expect(listed.map((item) => item.name)).toEqual(expect.arrayContaining(["默认卷", "草稿卷"]));
    const defaultBank = listed.find((item) => item.id === first.id);
    expect(defaultBank?.isDefault).toBe(true);
    expect(defaultBank?.enabledScore).toBe(100);
    expect(defaultBank?.questionCount).toBe(1);
  });

  it("ensures only one company-wide default bank via transaction", async () => {
    const first = await seedEnabledBank("第一套", true);
    const second = await seedEnabledBank("第二套");
    await setDefaultQuestionBank(testDb.db, second.id, actorId);
    const banks = await testDb.db.questionBank.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });
    expect(banks.find((bank) => bank.id === first.id)?.isDefault).toBe(false);
    expect(banks.find((bank) => bank.id === second.id)?.isDefault).toBe(true);
    expect(banks.filter((bank) => bank.isDefault)).toHaveLength(1);
    const logs = await testDb.db.auditLog.findMany({ where: { action: "QUESTION_BANK_SET_DEFAULT" } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("only permits an enabled, valid bank to become the company default", async () => {
    const draft = await createBlankQuestionBank(testDb.db, { name: "未完成草稿", actorId });
    await expect(setDefaultQuestionBank(testDb.db, draft.id, actorId)).rejects.toMatchObject({
      code: "BANK_NOT_READY",
    });

    await createQuestionBankQuestion(testDb.db, draft.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "不足百分",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    await expect(setDefaultQuestionBank(testDb.db, draft.id, actorId)).rejects.toMatchObject({
      code: "BANK_NOT_READY",
    });
  });

  it("does not create a new bank version when enabling an already enabled bank", async () => {
    const bank = await seedEnabledBank("幂等启用");
    const before = await testDb.db.questionBank.findUniqueOrThrow({ where: { id: bank.id } });
    await setQuestionBankStatus(testDb.db, bank.id, QuestionBankStatus.ENABLED, actorId);
    const after = await testDb.db.questionBank.findUniqueOrThrow({ where: { id: bank.id } });
    expect(after.versionNumber).toBe(before.versionNumber);
  });

  it("rejects enabling a bank whose enabled score is not exactly 100", async () => {
    const bank = await createBlankQuestionBank(testDb.db, { name: "未满分", actorId });
    await createQuestionBankQuestion(testDb.db, bank.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "半套题",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    await expect(
      setQuestionBankStatus(testDb.db, bank.id, QuestionBankStatus.ENABLED, actorId),
    ).rejects.toMatchObject({
      name: "QuestionBankError",
      message: expect.stringContaining("100"),
    });
  });

  it("protects the default bank from disable and soft delete without a replacement", async () => {
    const bank = await seedEnabledBank("唯一默认", true);
    await expect(
      setQuestionBankStatus(testDb.db, bank.id, QuestionBankStatus.DISABLED, actorId),
    ).rejects.toBeInstanceOf(QuestionBankError);
    await expect(softDeleteQuestionBank(testDb.db, bank.id, actorId)).rejects.toBeInstanceOf(
      QuestionBankError,
    );
    expect((await testDb.db.questionBank.findUniqueOrThrow({ where: { id: bank.id } })).deletedAt).toBeNull();
  });

  it("allows disable and soft delete after another bank becomes default", async () => {
    const first = await seedEnabledBank("旧默认", true);
    const second = await seedEnabledBank("新默认");
    await setDefaultQuestionBank(testDb.db, second.id, actorId);
    await setQuestionBankStatus(testDb.db, first.id, QuestionBankStatus.DISABLED, actorId);
    expect(
      (await testDb.db.questionBank.findUniqueOrThrow({ where: { id: first.id } })).status,
    ).toBe(QuestionBankStatus.DISABLED);
    await softDeleteQuestionBank(testDb.db, first.id, actorId);
    const deleted = await testDb.db.questionBank.findUniqueOrThrow({ where: { id: first.id } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isDefault).toBe(false);
    const listed = await listQuestionBanks(testDb.db);
    expect(listed.find((item) => item.id === first.id)).toBeUndefined();
  });

  it("deep-copies questions, options and blank answers into a new draft bank", async () => {
    const source = await createBlankQuestionBank(testDb.db, { name: "源题库", actorId });
    await createQuestionBankQuestion(testDb.db, source.id, {
      type: QuestionBankQuestionType.FILL_BLANK,
      prompt: "公司总部在____，及格分____",
      score: 100,
      enabled: true,
      blanks: [
        { blankIndex: 0, acceptableAnswers: ["上海", "SH"] },
        { blankIndex: 1, acceptableAnswers: ["80"] },
      ],
    }, actorId);
    await setQuestionBankStatus(testDb.db, source.id, QuestionBankStatus.ENABLED, actorId);
    await setDefaultQuestionBank(testDb.db, source.id, actorId);

    const copied = await copyQuestionBank(testDb.db, source.id, actorId, { name: "复制题库" });
    expect(copied).toMatchObject({
      name: "复制题库",
      status: QuestionBankStatus.DRAFT,
      isDefault: false,
      questionCount: 1,
      enabledScore: 100,
      source: QuestionBankSource.ONLINE,
    });
    const questions = await testDb.db.questionBankQuestion.findMany({
      where: { questionBankId: copied.id },
      include: { blankAnswers: { orderBy: { blankIndex: "asc" } }, options: true },
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]!.id).not.toBe(
      (await testDb.db.questionBankQuestion.findFirstOrThrow({ where: { questionBankId: source.id } })).id,
    );
    expect(questions[0]!.blankAnswers).toHaveLength(2);
    expect(questions[0]!.blankAnswers[0]!.acceptableAnswers).toEqual(["上海", "SH"]);
  });

  it("refreshQuestionBankTotals recomputes count and enabled score", async () => {
    const bank = await createBlankQuestionBank(testDb.db, { name: "汇总", actorId });
    await createQuestionBankQuestion(testDb.db, bank.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "一",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    await createQuestionBankQuestion(testDb.db, bank.id, {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "二",
      score: 60,
      enabled: false,
      options: [
        { label: "A", text: "对", isCorrect: true },
        { label: "B", text: "错", isCorrect: false },
      ],
    }, actorId);
    const totals = await refreshQuestionBankTotals(testDb.db, bank.id);
    expect(totals).toEqual({ questionCount: 2, enabledScore: 40 });
  });
});

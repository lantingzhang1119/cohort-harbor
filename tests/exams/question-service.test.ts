import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuestionType, Role, UserSource } from "@/generated/prisma/enums";
import {
  QuestionValidationError,
  updateExamSettings,
  upsertQuestion,
  validateEnabledExamScore,
} from "@/features/exams/question-service";
import { mockOnboardingQuestions } from "@/features/exams/exam-seed-data";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("question service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let examId: string;
  let actorId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    examId = (await testDb.db.exam.create({ data: { name: "题库测试" } })).id;
    actorId = (await testDb.db.user.create({ data: { employeeNo: "ADMIN-QUESTION", name: "题库管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash: await hashPassword("InitialPass!23") } })).id;
  });
  afterEach(async () => testDb.cleanup());

  it.each([
    { type: QuestionType.SINGLE, score: 5, correctKeys: ["A", "B"] },
    { type: QuestionType.TRUE_FALSE, score: 4, correctKeys: [] },
    { type: QuestionType.MULTIPLE, score: 4, correctKeys: [] },
    { type: QuestionType.SINGLE, score: 0, correctKeys: ["A"] },
  ])("rejects invalid $type question rules", async (invalid) => {
    await expect(
      upsertQuestion(testDb.db, examId, {
        sequence: 1,
        prompt: "无效测试题",
        enabled: true,
        options: [{ key: "A", text: "选项A" }, { key: "B", text: "选项B" }],
        ...invalid,
      }, actorId),
    ).rejects.toBeInstanceOf(QuestionValidationError);
  });

  it("persists the formal bank and validates exactly 100 enabled points", async () => {
    for (const question of mockOnboardingQuestions) {
      await upsertQuestion(testDb.db, examId, { ...question, enabled: true }, actorId);
    }
    await expect(validateEnabledExamScore(testDb.db, examId)).resolves.toBe(100);
    expect(await testDb.db.question.count({ where: { examId } })).toBe(23);
  });

  it("enforces exam duration, due days and watermark setting bounds", async () => {
    await expect(updateExamSettings(testDb.db, examId, { durationMinutes: 0, dueDaysAfterHire: 7, watermarkOpacity: 0.07 }, actorId)).rejects.toBeInstanceOf(QuestionValidationError);
    await expect(updateExamSettings(testDb.db, examId, { durationMinutes: 30, dueDaysAfterHire: 66, watermarkOpacity: 0.07 }, actorId)).rejects.toBeInstanceOf(QuestionValidationError);
    await expect(updateExamSettings(testDb.db, examId, { durationMinutes: 30, dueDaysAfterHire: 7, watermarkOpacity: 0.5 }, actorId)).rejects.toBeInstanceOf(QuestionValidationError);
    await expect(updateExamSettings(testDb.db, examId, { durationMinutes: 35, dueDaysAfterHire: 10, watermarkOpacity: 0.09 }, actorId)).resolves.toMatchObject({ durationMinutes: 35, dueDaysAfterHire: 10 });
  });
});

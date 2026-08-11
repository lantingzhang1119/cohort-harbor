import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuestionType, UserSource } from "@/generated/prisma/enums";
import {
  AttemptServiceError,
  ensureAssignment,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from "@/features/exams/attempt-service";
import { hashPassword } from "@/features/auth/password";
import { listExamResultsForUser } from "@/features/exams/result-service";
import { createTestDatabase } from "../helpers/test-db";

describe("attempt service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let examId: string;
  let employeeId: string;
  let otherId: string;
  const now = new Date("2026-07-16T10:00:00.000Z");

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    employeeId = (await testDb.db.user.create({ data: { employeeNo: "TEST-ATTEMPT", name: "考试员工", sourceType: UserSource.MANUAL, passwordHash, hiredAt: new Date("2026-07-10T00:00:00.000Z") } })).id;
    otherId = (await testDb.db.user.create({ data: { employeeNo: "TEST-OTHER", name: "其他员工", sourceType: UserSource.MANUAL, passwordHash } })).id;
    examId = (await testDb.db.exam.create({ data: { name: "生命周期测试", durationMinutes: 30, dueDaysAfterHire: 7, passingScore: 80, randomizeQuestions: true } })).id;
    const first = await testDb.db.question.create({ data: { examId, sequence: 1, type: QuestionType.SINGLE, prompt: "第一题", score: 60 } });
    await testDb.db.questionOption.createMany({ data: [{ questionId: first.id, optionKey: "A", text: "错误", isCorrect: false, sortOrder: 0 }, { questionId: first.id, optionKey: "B", text: "正确", isCorrect: true, sortOrder: 1 }] });
    const second = await testDb.db.question.create({ data: { examId, sequence: 2, type: QuestionType.MULTIPLE, prompt: "第二题", score: 40 } });
    await testDb.db.questionOption.createMany({ data: [{ questionId: second.id, optionKey: "A", text: "正确A", isCorrect: true, sortOrder: 0 }, { questionId: second.id, optionKey: "B", text: "错误B", isCorrect: false, sortOrder: 1 }, { questionId: second.id, optionKey: "C", text: "正确C", isCorrect: true, sortOrder: 2 }] });
  });
  afterEach(async () => testDb.cleanup());

  it("auto-assigns, snapshots a random order, and reuses the active attempt", async () => {
    const assignment = await ensureAssignment(testDb.db, employeeId, examId, now);
    expect(assignment.dueAt).toEqual(new Date("2026-07-17T00:00:00.000Z"));
    const first = await startAttempt(testDb.db, assignment.id, employeeId, { now, random: () => 0 });
    expect(first.questions).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain("correctOptionKeys");
    const repeated = await startAttempt(testDb.db, assignment.id, employeeId, { now, random: () => 1 });
    expect(repeated.attemptId).toBe(first.attemptId);
    expect(await testDb.db.examAttempt.count()).toBe(1);
  });

  it("autosaves only for the owner and rejects writes after server expiry", async () => {
    const assignment = await ensureAssignment(testDb.db, employeeId, examId, now);
    const attempt = await startAttempt(testDb.db, assignment.id, employeeId, { now });
    const questionId = attempt.questions[0]!.questionId;
    await expect(saveAnswer(testDb.db, attempt.attemptId, employeeId, questionId, ["A"], now)).resolves.toMatchObject({ selectedKeys: ["A"] });
    await expect(saveAnswer(testDb.db, attempt.attemptId, otherId, questionId, ["A"], now)).rejects.toBeInstanceOf(AttemptServiceError);
    await expect(saveAnswer(testDb.db, attempt.attemptId, employeeId, questionId, ["A"], new Date("2026-07-16T10:31:00.000Z"))).rejects.toMatchObject({ code: "ATTEMPT_EXPIRED" });
  });

  it("submits idempotently, scores snapshots and preserves history after edits", async () => {
    const assignment = await ensureAssignment(testDb.db, employeeId, examId, now);
    const attempt = await startAttempt(testDb.db, assignment.id, employeeId, { now, random: () => 1 });
    for (const question of attempt.questions) {
      await saveAnswer(testDb.db, attempt.attemptId, employeeId, question.questionId, question.options.filter((option) => option.text.startsWith("正确")).map((option) => option.key), now);
    }
    const submitted = await submitAttempt(testDb.db, attempt.attemptId, employeeId, { now: new Date("2026-07-16T10:05:00.000Z") });
    expect(submitted).toMatchObject({ score: 100, passed: true });
    const repeated = await submitAttempt(testDb.db, attempt.attemptId, employeeId, { now: new Date("2026-07-16T10:06:00.000Z") });
    expect(repeated).toMatchObject({ score: 100, passed: true });
    await testDb.db.question.updateMany({ where: { examId }, data: { prompt: "后来修改的题干" } });
    const snapshot = await testDb.db.attemptQuestion.findFirstOrThrow({ where: { attemptId: attempt.attemptId }, orderBy: { displayOrder: "asc" } });
    expect(snapshot.promptSnapshot).not.toBe("后来修改的题干");
  });

  it("reveals only the current user's submitted wrong answers when the exam setting allows it", async () => {
    const assignment = await ensureAssignment(testDb.db, employeeId, examId, now);
    const attempt = await startAttempt(testDb.db, assignment.id, employeeId, { now, random: () => 1 });
    const first = attempt.questions.find((question) => question.score === 60)!;
    const wrongKey = first.options.find((option) => !option.text.startsWith("正确"))!.key;
    await saveAnswer(testDb.db, attempt.attemptId, employeeId, first.questionId, [wrongKey], now);
    const second = attempt.questions.find((question) => question.score === 40)!;
    await saveAnswer(
      testDb.db,
      attempt.attemptId,
      employeeId,
      second.questionId,
      second.options.filter((option) => option.text.startsWith("正确")).map((option) => option.key),
      now,
    );
    await submitAttempt(testDb.db, attempt.attemptId, employeeId, { now: new Date("2026-07-16T10:05:00.000Z") });

    const hidden = await listExamResultsForUser(testDb.db, employeeId);
    expect(hidden[0]?.attempts[0]?.wrongAnswers).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain("correctKeys");

    await testDb.db.exam.update({ where: { id: examId }, data: { showWrongAnswers: true } });
    const visible = await listExamResultsForUser(testDb.db, employeeId);
    expect(visible[0]?.attempts[0]?.wrongAnswers).toEqual([
      expect.objectContaining({ questionId: first.questionId, selectedKeys: [wrongKey], correctKeys: ["B"] }),
    ]);
    expect(await listExamResultsForUser(testDb.db, otherId)).toEqual([]);
  });
});

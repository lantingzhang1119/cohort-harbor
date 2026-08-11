import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QuestionBankImportStatus,
  QuestionBankQuestionType,
  QuestionBankSource,
  QuestionBankStatus,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  confirmQuestionBankImport,
  getQuestionBankImportJob,
  startQuestionBankImport,
  updateQuestionBankImportDraft,
} from "@/features/question-banks/import/import-service";
import {
  createMissingAnswerExcelWorkbook,
  createStandardExcelWorkbook,
  createStandardWordDocument,
} from "../fixtures/question-bank-import";
import { createTestDatabase } from "../helpers/test-db";

describe("question bank import service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;
  let employeeId: string;
  let privateRoot: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-qb-import-"));
    actorId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "IMPORT-ADMIN",
          name: "导入管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("ImportPass!23"),
        },
      })
    ).id;
    employeeId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "IMPORT-EMPLOYEE",
          name: "普通员工",
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("EmployeePass23"),
        },
      })
    ).id;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  it("stores original privately, reaches review with stages/warnings/fragment maps", async () => {
    const job = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "sample.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createStandardExcelWorkbook(),
    });

    expect(job.status).toBe(QuestionBankImportStatus.REVIEW_READY);
    expect(job.questionBankId).toBeNull();
    expect(job.source).toBe(QuestionBankSource.EXCEL);
    expect(job.parsedPayload).toMatchObject({
      stage: "REVIEW",
      questions: expect.any(Array),
      sourceFragments: expect.any(Array),
    });
    const payload = job.parsedPayload as {
      questions: Array<{ sourceFragmentIds: string[]; originalSnippet: string }>;
      sourceFragments: Array<{ id: string; text: string }>;
    };
    expect(payload.questions.length).toBe(3);
    expect(payload.sourceFragments.length).toBeGreaterThan(0);
    expect(payload.questions[0]!.sourceFragmentIds[0]).toBeTruthy();
    expect(payload.questions[0]!.originalSnippet.length).toBeGreaterThan(0);

    const asset = await testDb.db.fileAsset.findUniqueOrThrow({
      where: { id: job.sourceFileAssetId },
    });
    expect(asset.kind).toBe("QUESTION_BANK_SOURCE");
    expect(asset.storageKey).toMatch(/^question-banks\//);
  });

  it("does not create a formal bank until confirm; confirm writes editable questions", async () => {
    const job = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "mixed.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: createStandardWordDocument(),
    });
    expect(await testDb.db.questionBank.count()).toBe(0);

    const confirmed = await confirmQuestionBankImport(testDb.db, job.id, {
      actorId,
      bankName: "确认后的题库",
    });
    expect(confirmed.status).toBe(QuestionBankImportStatus.CONFIRMED);
    expect(confirmed.questionBankId).toBeTruthy();

    const bank = await testDb.db.questionBank.findUniqueOrThrow({
      where: { id: confirmed.questionBankId! },
      include: {
        questions: {
          include: { options: true, blankAnswers: true },
          orderBy: { sequence: "asc" },
        },
      },
    });
    expect(bank).toMatchObject({
      name: "确认后的题库",
      status: QuestionBankStatus.DRAFT,
      source: QuestionBankSource.WORD,
      questionCount: 3,
    });
    expect(bank.questions[0]!.type).toBe(QuestionBankQuestionType.SINGLE_CHOICE);
    expect(bank.questions[0]!.options.some((option) => option.isCorrect)).toBe(true);
    expect(bank.questions[2]!.blankAnswers[0]!.acceptableAnswers).toEqual(
      expect.arrayContaining(["北京", "Beijing"]),
    );

    // Still editable via normal question bank tables
    await testDb.db.questionBankQuestion.update({
      where: { id: bank.questions[0]!.id },
      data: { prompt: "修改后的题干" },
    });
    const updated = await testDb.db.questionBankQuestion.findUniqueOrThrow({
      where: { id: bank.questions[0]!.id },
    });
    expect(updated.prompt).toBe("修改后的题干");
  });

  it("blocks confirm while needsReview remains and never creates a half bank on failed confirm", async () => {
    const job = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "missing.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createMissingAnswerExcelWorkbook(),
    });
    expect(job.status).toBe(QuestionBankImportStatus.REVIEW_READY);
    const payload = job.parsedPayload as { questions: Array<{ needsReview: boolean }> };
    expect(payload.questions[0]!.needsReview).toBe(true);

    await expect(
      confirmQuestionBankImport(testDb.db, job.id, { actorId }),
    ).rejects.toThrow(/复核|needsReview|答案/i);
    expect(await testDb.db.questionBank.count()).toBe(0);

    await updateQuestionBankImportDraft(testDb.db, job.id, {
      actorId,
      questions: [
        {
          localId: (job.parsedPayload as { questions: Array<{ localId: string }> }).questions[0]!.localId,
          type: QuestionBankQuestionType.SINGLE_CHOICE,
          prompt: "缺少答案的题目",
          score: 100,
          options: [
            { label: "A", text: "是", isCorrect: true },
            { label: "B", text: "否", isCorrect: false },
          ],
          blanks: [],
          needsReview: false,
          reviewReasons: [],
          reviewConfirmed: true,
          sourceFragmentIds: [],
          originalSnippet: "缺少答案的题目",
          sequence: 1,
        },
      ],
    });

    const confirmed = await confirmQuestionBankImport(testDb.db, job.id, {
      actorId,
      bankName: "人工修正后",
    });
    expect(confirmed.status).toBe(QuestionBankImportStatus.CONFIRMED);
    expect(await testDb.db.questionBank.count()).toBe(1);
  });

  it("get job returns stage and warnings for admin polling", async () => {
    const started = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "poll.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createStandardExcelWorkbook(),
    });
    const job = await getQuestionBankImportJob(testDb.db, started.id, actorId);
    expect(job.stage).toBe("REVIEW");
    expect(job.status).toBe(QuestionBankImportStatus.REVIEW_READY);
    expect(Array.isArray(job.warnings)).toBe(true);
  });

  it("enforces admin permission inside the service layer", async () => {
    const started = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "private.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createStandardExcelWorkbook(),
    });

    await expect(
      getQuestionBankImportJob(testDb.db, started.id, employeeId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not trust a client clearing needsReview without explicit review confirmation", async () => {
    const started = await startQuestionBankImport(testDb.db, {
      actorId,
      privateRoot,
      fileName: "review.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createMissingAnswerExcelWorkbook(),
    });
    const original = (started.parsedPayload as {
      questions: Array<{
        localId: string;
        sequence: number;
        type: QuestionBankQuestionType;
        prompt: string;
        score: number;
        options: Array<{ label: string; text: string; isCorrect: boolean | null }>;
        blanks: [];
        sourceFragmentIds: string[];
        originalSnippet: string;
      }>;
    }).questions[0]!;

    await updateQuestionBankImportDraft(testDb.db, started.id, {
      actorId,
      questions: [{
        ...original,
        options: original.options.map((option, index) => ({
          ...option,
          isCorrect: index === 0,
        })),
        needsReview: false,
        reviewReasons: [],
      }],
    });

    await expect(
      confirmQuestionBankImport(testDb.db, started.id, { actorId }),
    ).rejects.toMatchObject({ code: "NEEDS_REVIEW" });

    await updateQuestionBankImportDraft(testDb.db, started.id, {
      actorId,
      questions: [{
        ...original,
        options: original.options.map((option, index) => ({
          ...option,
          isCorrect: index === 0,
        })),
        needsReview: true,
        reviewReasons: original.prompt ? ["缺少答案"] : [],
        reviewConfirmed: true,
      }],
    });
    const confirmed = await confirmQuestionBankImport(testDb.db, started.id, { actorId });
    expect(confirmed.status).toBe(QuestionBankImportStatus.CONFIRMED);
  });

  it("rejects malformed OOXML before creating an asset or import job", async () => {
    const fakeZip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(
      startQuestionBankImport(testDb.db, {
        actorId,
        privateRoot,
        fileName: "broken.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: fakeZip,
      }),
    ).rejects.toThrow(/Office|OOXML|结构|压缩包/i);
    expect(await testDb.db.questionBankImportJob.count()).toBe(0);
    expect(await testDb.db.fileAsset.count()).toBe(0);
  });

  it("keeps a failed import source privately for diagnosis instead of leaving a broken asset", async () => {
    await expect(
      startQuestionBankImport(testDb.db, {
        actorId,
        privateRoot,
        fileName: "broken.pdf",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-not-a-real-document"),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_FAILED" });

    const failed = await testDb.db.questionBankImportJob.findFirstOrThrow({
      where: { status: QuestionBankImportStatus.FAILED },
      include: { sourceFileAsset: true },
    });
    expect(failed.errorMessage).toBeTruthy();
    const { access } = await import("node:fs/promises");
    await expect(
      access(path.join(privateRoot, failed.sourceFileAsset.storageKey)),
    ).resolves.toBeUndefined();
  });
});

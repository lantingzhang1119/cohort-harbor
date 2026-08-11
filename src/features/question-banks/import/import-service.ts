import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  FileAssetKind,
  QuestionBankImportStatus,
  QuestionBankQuestionType,
  QuestionBankSource,
  QuestionBankStatus,
} from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { QuestionBankImportError } from "@/features/question-banks/import/import-errors";
import {
  assertImportDraftReady,
  normalizeImportDraftQuestions,
} from "@/features/question-banks/import/draft-validation";
import { validateAndStageQuestionBankImportFile } from "@/features/question-banks/import/file-validation";
import type {
  DraftQuestionInput,
  ImportWarning,
  ParsedImportPayload,
  ParseResult,
} from "@/features/question-banks/import/import-types";
import { parseExcelQuestionBank } from "@/features/question-banks/import/parsers/excel-parser";
import {
  extractPdfPageTexts,
  isLikelyScannedPdf,
  parsePdfTextQuestionBank,
} from "@/features/question-banks/import/parsers/pdf-text-parser";
import { parsePdfOcrQuestionBank } from "@/features/question-banks/import/parsers/pdf-ocr-parser";
import { parseWordQuestionBank } from "@/features/question-banks/import/parsers/word-parser";
import { convertOfficeToPdf } from "@/features/policies/document-preview-service";
import { requireQuestionBankAdmin } from "@/features/question-banks/permissions";
import { refreshQuestionBankTotals } from "@/features/question-banks/question-service";
import { storeStagedPrivateUpload } from "@/lib/storage/private-upload-validation";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

function asPayload(value: unknown): ParsedImportPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      stage: "FAILED",
      bankName: "导入题库",
      mode: "BEST_EFFORT",
      questions: [],
      sourceFragments: [],
    };
  }
  return value as ParsedImportPayload;
}

function asWarnings(value: unknown): ImportWarning[] {
  if (!Array.isArray(value)) return [];
  return value as ImportWarning[];
}

async function parseBySource(
  source: QuestionBankSource,
  extension: string,
  bytes: Uint8Array,
): Promise<ParseResult> {
  if (source === QuestionBankSource.EXCEL) {
    return parseExcelQuestionBank(bytes);
  }
  if (source === QuestionBankSource.WORD) {
    if (extension === ".doc") {
      const workDirectory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-qb-doc-"));
      try {
        const inputPath = path.join(workDirectory, `source${extension}`);
        await writeFile(inputPath, bytes);
        const pdfBytes = await convertOfficeToPdf(inputPath, workDirectory, { timeoutMs: 90_000 });
        const textResult = await parsePdfTextQuestionBank(pdfBytes);
        return {
          ...textResult,
          source: QuestionBankSource.WORD,
          bankName: textResult.bankName === "PDF 导入题库" ? "Word 导入题库" : textResult.bankName,
        };
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
    return parseWordQuestionBank(bytes);
  }

  // PDF: text first; scanned -> local OCR
  const pages = await extractPdfPageTexts(bytes);
  if (isLikelyScannedPdf(pages)) {
    return parsePdfOcrQuestionBank(bytes, { pageCount: pages.length });
  }
  return parsePdfTextQuestionBank(bytes);
}

function integrityCheck(result: ParseResult): ImportWarning[] {
  const warnings = [...result.warnings];
  if (!result.questions.length) {
    warnings.push({ code: "NO_QUESTIONS", message: "未解析到任何题目" });
  }
  const totalScore = result.questions.reduce((sum, question) => sum + (question.score ?? 0), 0);
  if (totalScore > 0 && totalScore !== 100) {
    warnings.push({
      code: "SCORE_NOT_100",
      message: `当前识别分值合计为 ${totalScore}，确认后可在线调整至 100`,
    });
  }
  return warnings;
}

async function stageAndStoreOriginal(options: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  privateRoot: string;
}) {
  const tempBase = path.join(options.privateRoot, "tmp");
  await mkdir(tempBase, { recursive: true, mode: 0o700 });
  const { descriptor, staged } = await validateAndStageQuestionBankImportFile(
    {
      fileName: options.fileName,
      mimeType: options.mimeType,
      bytes: options.bytes,
    },
    { tempRoot: tempBase },
  );
  try {
    const stored = await storeStagedPrivateUpload(staged.stagedPath, {
      privateRoot: options.privateRoot,
      namespace: "question-banks/sources",
      extension: descriptor.extension,
    });
    return {
      descriptor,
      stored,
      sha256: staged.sha256,
      sizeBytes: staged.sizeBytes,
      async cleanupTemp() {
        await staged.cleanup();
      },
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

export async function startQuestionBankImport(
  db: Db,
  input: {
    actorId: string;
    privateRoot: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  },
) {
  const { snapshot } = await requireQuestionBankAdmin(db, input.actorId);

  const staged = await stageAndStoreOriginal({
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.bytes,
    privateRoot: input.privateRoot,
  });
  const { descriptor } = staged;

  let jobId: string | null = null;
  let sourceCommitted = false;
  try {
    const initialPayload: ParsedImportPayload = {
      stage: "EXTRACTING",
      bankName: path.parse(input.fileName).name || "导入题库",
      mode: "BEST_EFFORT",
      questions: [],
      sourceFragments: [],
    };

    const { job } = await db.$transaction(async (transaction) => {
      const asset = await transaction.fileAsset.create({
        data: {
          kind: FileAssetKind.QUESTION_BANK_SOURCE,
          storageKey: staged.stored.storageKey,
          originalName: input.fileName,
          mimeType: descriptor.mimeType,
          sizeBytes: staged.sizeBytes,
          sha256: staged.sha256,
          uploadedById: input.actorId,
          uploadedBySnapshot: snapshot,
        },
      });
      const job = await transaction.questionBankImportJob.create({
        data: {
          sourceFileAssetId: asset.id,
          source: descriptor.source,
          status: QuestionBankImportStatus.PROCESSING,
          originalName: input.fileName,
          parsedPayload: initialPayload as unknown as Prisma.InputJsonValue,
          warnings: [] as unknown as Prisma.InputJsonValue,
          createdById: input.actorId,
          createdBySnapshot: snapshot,
        },
      });
      return { job };
    });
    jobId = job.id;
    sourceCommitted = true;

    const parsed = await parseBySource(descriptor.source, descriptor.extension, input.bytes);
    const warnings = integrityCheck(parsed);
    const payload: ParsedImportPayload = {
      stage: "REVIEW",
      bankName: parsed.bankName,
      description: parsed.description ?? null,
      mode: parsed.mode,
      questions: parsed.questions,
      sourceFragments: parsed.sourceFragments,
      extraction: parsed.extraction,
    };

    const updated = await db.questionBankImportJob.update({
      where: { id: job.id },
      data: {
        source: parsed.source,
        status: QuestionBankImportStatus.REVIEW_READY,
        parsedPayload: payload as unknown as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        ocrLanguage: parsed.extraction?.language ?? null,
        errorMessage: null,
      },
    });

    await writeAuditLog(db, {
      actorId: input.actorId,
      action: "QUESTION_BANK_IMPORT_UPLOAD",
      targetType: "QUESTION_BANK_IMPORT_JOB",
      targetId: job.id,
      result: "SUCCESS",
      metadata: {
        originalName: input.fileName,
        source: parsed.source,
        questionCount: parsed.questions.length,
        mode: parsed.mode,
      },
    });

    return updated;
  } catch (error) {
    if (!sourceCommitted) {
      await staged.stored.cleanup().catch(() => undefined);
    }
    if (jobId) {
      await db.questionBankImportJob.update({
        where: { id: jobId },
        data: {
          status: QuestionBankImportStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : "导入失败",
          parsedPayload: {
            stage: "FAILED",
            bankName: "导入题库",
            mode: "BEST_EFFORT",
            questions: [],
            sourceFragments: [],
          } satisfies ParsedImportPayload as unknown as Prisma.InputJsonValue,
        },
      }).catch(() => undefined);
    }
    if (error instanceof QuestionBankImportError) throw error;
    throw new QuestionBankImportError(
      error instanceof Error ? error.message : "题库导入失败",
      "IMPORT_FAILED",
    );
  } finally {
    await staged.cleanupTemp().catch(() => undefined);
  }
}

export async function getQuestionBankImportJob(db: Db, jobId: string, actorId: string) {
  await requireQuestionBankAdmin(db, actorId);
  const job = await db.questionBankImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new QuestionBankImportError("导入任务不存在", "NOT_FOUND");
  const payload = asPayload(job.parsedPayload);
  return {
    ...job,
    stage: payload.stage,
    payload,
    warnings: asWarnings(job.warnings),
  };
}

export async function updateQuestionBankImportDraft(
  db: Db,
  jobId: string,
  input: {
    actorId: string;
    bankName?: string;
    questions: DraftQuestionInput[];
  },
) {
  await requireQuestionBankAdmin(db, input.actorId);
  const job = await db.questionBankImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new QuestionBankImportError("导入任务不存在", "NOT_FOUND");
  if (job.status !== QuestionBankImportStatus.REVIEW_READY) {
    throw new QuestionBankImportError("仅复核中的导入任务可修改草稿", "INVALID_STATUS");
  }
  const payload = asPayload(job.parsedPayload);
  const nextPayload: ParsedImportPayload = {
    ...payload,
    stage: "REVIEW",
    bankName: input.bankName?.trim() || payload.bankName,
    questions: normalizeImportDraftQuestions(
      input.questions.map((question) => ({
        ...question,
        localId: question.localId || randomUUID(),
      })),
      payload.questions,
    ),
  };
  return db.questionBankImportJob.update({
    where: { id: jobId },
    data: {
      parsedPayload: nextPayload as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function confirmQuestionBankImport(
  db: Db,
  jobId: string,
  input: { actorId: string; bankName?: string; description?: string | null },
) {
  const { snapshot } = await requireQuestionBankAdmin(db, input.actorId);
  const job = await db.questionBankImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new QuestionBankImportError("导入任务不存在", "NOT_FOUND");
  if (job.status === QuestionBankImportStatus.CONFIRMED) {
    throw new QuestionBankImportError("导入任务已确认", "ALREADY_CONFIRMED");
  }
  if (job.status !== QuestionBankImportStatus.REVIEW_READY) {
    throw new QuestionBankImportError("导入任务未就绪，无法确认", "INVALID_STATUS");
  }

  const payload = asPayload(job.parsedPayload);
  const questions = payload.questions;
  assertImportDraftReady(questions);

  const bankName = (input.bankName?.trim() || payload.bankName || job.originalName).trim();
  if (!bankName) throw new QuestionBankImportError("题库名称不能为空");

  try {
    return await db.$transaction(async (transaction: Tx) => {
      const claimed = await transaction.questionBankImportJob.updateMany({
        where: { id: jobId, status: QuestionBankImportStatus.REVIEW_READY },
        data: { status: QuestionBankImportStatus.PROCESSING },
      });
      if (claimed.count !== 1) {
        const current = await transaction.questionBankImportJob.findUnique({
          where: { id: jobId },
          select: { status: true },
        });
        throw new QuestionBankImportError(
          current?.status === QuestionBankImportStatus.CONFIRMED
            ? "导入任务已确认"
            : "导入任务状态已变化，请刷新后重试",
          current?.status === QuestionBankImportStatus.CONFIRMED
            ? "ALREADY_CONFIRMED"
            : "INVALID_STATUS",
        );
      }
      const bank = await transaction.questionBank.create({
        data: {
          name: bankName,
          description: input.description?.trim() || payload.description || null,
          status: QuestionBankStatus.DRAFT,
          source: job.source,
          sourceFileAssetId: job.sourceFileAssetId,
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

      for (const [index, question] of questions.entries()) {
        const created = await transaction.questionBankQuestion.create({
          data: {
            questionBankId: bank.id,
            sequence: index + 1,
            type: question.type!,
            prompt: question.prompt.trim(),
            score: question.score!,
            enabled: true,
          },
        });
        if (
          question.type === QuestionBankQuestionType.SINGLE_CHOICE ||
          question.type === QuestionBankQuestionType.MULTIPLE_CHOICE
        ) {
          await transaction.questionBankOption.createMany({
            data: question.options.map((option, optionIndex) => ({
              questionId: created.id,
              label: option.label.trim().toUpperCase(),
              text: option.text.trim(),
              isCorrect: Boolean(option.isCorrect),
              sortOrder: optionIndex,
            })),
          });
        }
        if (question.type === QuestionBankQuestionType.FILL_BLANK) {
          await transaction.questionBankBlankAnswer.createMany({
            data: question.blanks.map((blank, blankIndex) => ({
              questionId: created.id,
              blankIndex: blank.blankIndex,
              acceptableAnswers: blank.acceptableAnswers as Prisma.InputJsonValue,
              sortOrder: blankIndex,
            })),
          });
        }
      }

      await refreshQuestionBankTotals(transaction, bank.id);

      const confirmed = await transaction.questionBankImportJob.update({
        where: { id: jobId },
        data: {
          status: QuestionBankImportStatus.CONFIRMED,
          questionBankId: bank.id,
          confirmedAt: new Date(),
          parsedPayload: {
            ...payload,
            stage: "DONE",
            bankName,
          } satisfies ParsedImportPayload as unknown as Prisma.InputJsonValue,
        },
      });

      await writeAuditLog(transaction, {
        actorId: input.actorId,
        action: "QUESTION_BANK_IMPORT_CONFIRM",
        targetType: "QUESTION_BANK",
        targetId: bank.id,
        result: "SUCCESS",
        metadata: {
          importJobId: jobId,
          questionCount: questions.length,
          source: job.source,
        },
      });

      return confirmed;
    });
  } catch (error) {
    // Transaction rollback guarantees no half bank; rethrow domain errors.
    if (error instanceof QuestionBankImportError) throw error;
    throw new QuestionBankImportError(
      error instanceof Error ? error.message : "确认导入失败，未生成题库",
      "CONFIRM_FAILED",
    );
  }
}

export function toImportJobDto(job: Awaited<ReturnType<typeof getQuestionBankImportJob>>) {
  const payload = job.payload;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    source: job.source,
    originalName: job.originalName,
    questionBankId: job.questionBankId,
    warnings: job.warnings,
    errorMessage: job.errorMessage,
    ocrLanguage: job.ocrLanguage,
    bankName: payload.bankName,
    mode: payload.mode,
    questions: payload.questions,
    sourceFragments: payload.sourceFragments,
    extraction: payload.extraction,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    confirmedAt: job.confirmedAt?.toISOString() ?? null,
  };
}

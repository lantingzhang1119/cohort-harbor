-- Additive content lifecycle fields. Existing city scope remains for compatibility only.
ALTER TABLE "Policy" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Policy" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Policy" ADD COLUMN "deletedBySnapshot" JSONB;
ALTER TABLE "Policy" ADD COLUMN "statusBeforeDelete" TEXT;

ALTER TABLE "PolicyVersion" ADD COLUMN "previewStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "PolicyVersion" ADD COLUMN "previewAssetId" TEXT REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PolicyVersion" ADD COLUMN "previewFormat" TEXT;
ALTER TABLE "PolicyVersion" ADD COLUMN "previewMetadata" JSONB;
ALTER TABLE "PolicyVersion" ADD COLUMN "previewError" TEXT;
ALTER TABLE "PolicyVersion" ADD COLUMN "previewGeneratedAt" DATETIME;
ALTER TABLE "PolicyVersion" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "PolicyVersion" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PolicyVersion" ADD COLUMN "deletedBySnapshot" JSONB;

-- Existing valid PDFs are already safe preview artifacts and remain readable after migration.
UPDATE "PolicyVersion"
SET
  "previewStatus" = 'READY',
  "previewAssetId" = "fileAssetId",
  "previewFormat" = 'PDF',
  "previewGeneratedAt" = "createdAt"
WHERE "fileAssetId" IN (
  SELECT "id" FROM "FileAsset"
  WHERE lower("mimeType") = 'application/pdf'
     OR lower("originalName") LIKE '%.pdf'
);

ALTER TABLE "OnboardingMaterial" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "OnboardingMaterial" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OnboardingMaterial" ADD COLUMN "deletedBySnapshot" JSONB;
ALTER TABLE "OnboardingMaterial" ADD COLUMN "statusBeforeDelete" TEXT;

ALTER TABLE "OnboardingMaterialVersion" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "OnboardingMaterialVersion" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OnboardingMaterialVersion" ADD COLUMN "deletedBySnapshot" JSONB;

CREATE TABLE "QuestionBank" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "source" TEXT NOT NULL DEFAULT 'ONLINE',
  "sourceFileAssetId" TEXT,
  "legacyExamId" TEXT,
  "versionNumber" INTEGER NOT NULL DEFAULT 1,
  "passingScore" INTEGER NOT NULL DEFAULT 80,
  "durationMinutes" INTEGER NOT NULL DEFAULT 30,
  "randomizeQuestions" BOOLEAN NOT NULL DEFAULT true,
  "randomizeOptions" BOOLEAN NOT NULL DEFAULT true,
  "showWrongAnswers" BOOLEAN NOT NULL DEFAULT false,
  "enabledScore" INTEGER NOT NULL DEFAULT 0,
  "questionCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdBySnapshot" JSONB NOT NULL,
  "updatedById" TEXT,
  "updatedBySnapshot" JSONB NOT NULL,
  "deletedAt" DATETIME,
  "deletedById" TEXT,
  "deletedBySnapshot" JSONB,
  "statusBeforeDelete" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "QuestionBank_sourceFileAssetId_fkey" FOREIGN KEY ("sourceFileAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "QuestionBank_legacyExamId_fkey" FOREIGN KEY ("legacyExamId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "QuestionBank_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "QuestionBank_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "QuestionBank_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "QuestionBankQuestion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionBankId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "QuestionBankQuestion_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuestionBankOption" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "isCorrect" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "QuestionBankOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuestionBankQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuestionBankBlankAnswer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionId" TEXT NOT NULL,
  "blankIndex" INTEGER NOT NULL,
  "acceptableAnswers" JSONB NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "QuestionBankBlankAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuestionBankQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "QuestionBankImportJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionBankId" TEXT,
  "sourceFileAssetId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "originalName" TEXT NOT NULL,
  "parsedPayload" JSONB,
  "warnings" JSONB,
  "errorMessage" TEXT,
  "ocrLanguage" TEXT,
  "createdById" TEXT,
  "createdBySnapshot" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "confirmedAt" DATETIME,
  CONSTRAINT "QuestionBankImportJob_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "QuestionBankImportJob_sourceFileAssetId_fkey" FOREIGN KEY ("sourceFileAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "QuestionBankImportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ExamPaperSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questionBankId" TEXT NOT NULL,
  "questionBankVersion" INTEGER NOT NULL,
  "questionBankName" TEXT NOT NULL,
  "questions" JSONB NOT NULL,
  "questionCount" INTEGER NOT NULL,
  "totalScore" INTEGER NOT NULL,
  "passingScore" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamPaperSnapshot_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ExamTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "questionBankId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "startsAt" DATETIME NOT NULL,
  "endsAt" DATETIME NOT NULL,
  "passingScore" INTEGER NOT NULL DEFAULT 80,
  "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
  "publishedById" TEXT,
  "publishedBySnapshot" JSONB NOT NULL,
  "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExamTask_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExamTask_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ExamPaperSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExamTask_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ExamTaskAssignment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "currentAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "score" INTEGER,
  "passed" BOOLEAN,
  "startedAt" DATETIME,
  "submittedAt" DATETIME,
  "expiredAt" DATETIME,
  "processedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExamTaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ExamTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExamTaskAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExamTaskAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assignmentId" TEXT NOT NULL,
  "attemptNo" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "submittedAt" DATETIME,
  "elapsedSeconds" INTEGER,
  "score" INTEGER,
  "passed" BOOLEAN,
  "submissionReason" TEXT,
  CONSTRAINT "ExamTaskAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExamTaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExamTaskAnswer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "attemptId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "awardedScore" INTEGER,
  "savedAt" DATETIME NOT NULL,
  CONSTRAINT "ExamTaskAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamTaskAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExamTaskRetakeApplication" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "assignmentId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewerId" TEXT,
  "reviewerSnapshot" JSONB,
  "reviewNote" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" DATETIME,
  CONSTRAINT "ExamTaskRetakeApplication_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExamTaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExamTaskRetakeApplication_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExamTaskRetakeApplication_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "Notification" ADD COLUMN "href" TEXT;
ALTER TABLE "Notification" ADD COLUMN "examTaskAssignmentId" TEXT REFERENCES "ExamTaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE INDEX "Policy_deletedAt_idx" ON "Policy"("deletedAt");
CREATE INDEX "PolicyVersion_previewStatus_idx" ON "PolicyVersion"("previewStatus");
CREATE INDEX "PolicyVersion_deletedAt_idx" ON "PolicyVersion"("deletedAt");
CREATE INDEX "OnboardingMaterial_deletedAt_idx" ON "OnboardingMaterial"("deletedAt");
CREATE INDEX "OnboardingMaterialVersion_deletedAt_idx" ON "OnboardingMaterialVersion"("deletedAt");
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_examTaskAssignmentId_type_idx" ON "Notification"("examTaskAssignmentId", "type");

CREATE UNIQUE INDEX "QuestionBank_legacyExamId_key" ON "QuestionBank"("legacyExamId");
CREATE INDEX "QuestionBank_status_updatedAt_idx" ON "QuestionBank"("status", "updatedAt");
CREATE INDEX "QuestionBank_deletedAt_idx" ON "QuestionBank"("deletedAt");
CREATE INDEX "QuestionBank_source_idx" ON "QuestionBank"("source");
CREATE INDEX "QuestionBankQuestion_questionBankId_enabled_idx" ON "QuestionBankQuestion"("questionBankId", "enabled");
CREATE UNIQUE INDEX "QuestionBankQuestion_questionBankId_sequence_key" ON "QuestionBankQuestion"("questionBankId", "sequence");
CREATE INDEX "QuestionBankOption_questionId_sortOrder_idx" ON "QuestionBankOption"("questionId", "sortOrder");
CREATE UNIQUE INDEX "QuestionBankOption_questionId_label_key" ON "QuestionBankOption"("questionId", "label");
CREATE INDEX "QuestionBankBlankAnswer_questionId_sortOrder_idx" ON "QuestionBankBlankAnswer"("questionId", "sortOrder");
CREATE UNIQUE INDEX "QuestionBankBlankAnswer_questionId_blankIndex_key" ON "QuestionBankBlankAnswer"("questionId", "blankIndex");
CREATE INDEX "QuestionBankImportJob_status_createdAt_idx" ON "QuestionBankImportJob"("status", "createdAt");
CREATE INDEX "QuestionBankImportJob_questionBankId_idx" ON "QuestionBankImportJob"("questionBankId");
CREATE INDEX "ExamPaperSnapshot_questionBankId_createdAt_idx" ON "ExamPaperSnapshot"("questionBankId", "createdAt");
CREATE UNIQUE INDEX "ExamTask_idempotencyKey_key" ON "ExamTask"("idempotencyKey");
CREATE UNIQUE INDEX "ExamTask_snapshotId_key" ON "ExamTask"("snapshotId");
CREATE INDEX "ExamTask_status_startsAt_endsAt_idx" ON "ExamTask"("status", "startsAt", "endsAt");
CREATE INDEX "ExamTask_questionBankId_publishedAt_idx" ON "ExamTask"("questionBankId", "publishedAt");
CREATE INDEX "ExamTaskAssignment_userId_status_idx" ON "ExamTaskAssignment"("userId", "status");
CREATE INDEX "ExamTaskAssignment_status_taskId_idx" ON "ExamTaskAssignment"("status", "taskId");
CREATE UNIQUE INDEX "ExamTaskAssignment_taskId_userId_key" ON "ExamTaskAssignment"("taskId", "userId");
CREATE INDEX "ExamTaskAttempt_status_expiresAt_idx" ON "ExamTaskAttempt"("status", "expiresAt");
CREATE UNIQUE INDEX "ExamTaskAttempt_assignmentId_attemptNo_key" ON "ExamTaskAttempt"("assignmentId", "attemptNo");
CREATE UNIQUE INDEX "ExamTaskAnswer_attemptId_questionId_key" ON "ExamTaskAnswer"("attemptId", "questionId");
CREATE INDEX "ExamTaskRetakeApplication_status_createdAt_idx" ON "ExamTaskRetakeApplication"("status", "createdAt");

-- Idempotent legacy projection. The source Exam/Question rows remain untouched for history.
INSERT OR IGNORE INTO "QuestionBank" (
  "id", "name", "description", "isDefault", "status", "source", "legacyExamId",
  "versionNumber", "passingScore", "durationMinutes", "randomizeQuestions",
  "randomizeOptions", "showWrongAnswers", "enabledScore", "questionCount",
  "createdBySnapshot", "updatedBySnapshot", "createdAt", "updatedAt"
)
SELECT
  'legacy-bank-' || exam."id",
  exam."name",
  '由历史考试自动迁移',
  false,
  CASE WHEN exam."enabled" = true THEN 'ENABLED' ELSE 'DISABLED' END,
  'LEGACY',
  exam."id",
  1,
  exam."passingScore",
  exam."durationMinutes",
  exam."randomizeQuestions",
  exam."randomizeOptions",
  exam."showWrongAnswers",
  COALESCE((SELECT SUM(question."score") FROM "Question" question WHERE question."examId" = exam."id" AND question."enabled" = true), 0),
  (SELECT COUNT(*) FROM "Question" question WHERE question."examId" = exam."id"),
  json_object('source', 'legacy-migration'),
  json_object('source', 'legacy-migration'),
  exam."createdAt",
  exam."updatedAt"
FROM "Exam" exam;

INSERT OR IGNORE INTO "QuestionBankQuestion" (
  "id", "questionBankId", "sequence", "type", "prompt", "score", "enabled", "createdAt", "updatedAt"
)
SELECT
  'legacy-bank-question-' || question."id",
  'legacy-bank-' || question."examId",
  question."sequence",
  CASE WHEN question."type" = 'MULTIPLE' THEN 'MULTIPLE_CHOICE' ELSE 'SINGLE_CHOICE' END,
  question."prompt",
  question."score",
  question."enabled",
  question."createdAt",
  question."updatedAt"
FROM "Question" question
WHERE EXISTS (SELECT 1 FROM "QuestionBank" bank WHERE bank."id" = 'legacy-bank-' || question."examId");

INSERT OR IGNORE INTO "QuestionBankOption" (
  "id", "questionId", "label", "text", "isCorrect", "sortOrder"
)
SELECT
  'legacy-bank-option-' || option."id",
  'legacy-bank-question-' || option."questionId",
  option."optionKey",
  option."text",
  option."isCorrect",
  option."sortOrder"
FROM "QuestionOption" option
WHERE EXISTS (SELECT 1 FROM "QuestionBankQuestion" question WHERE question."id" = 'legacy-bank-question-' || option."questionId");

UPDATE "QuestionBank"
SET "isDefault" = true
WHERE "id" = (
  SELECT bank."id"
  FROM "QuestionBank" bank
  LEFT JOIN "Exam" exam ON exam."id" = bank."legacyExamId"
  WHERE bank."deletedAt" IS NULL
  ORDER BY CASE WHEN bank."name" = '入职学习考试' THEN 0 ELSE 1 END, exam."createdAt", bank."id"
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "QuestionBank" WHERE "isDefault" = true AND "deletedAt" IS NULL);

CREATE UNIQUE INDEX "QuestionBank_one_default_key"
ON "QuestionBank"("isDefault")
WHERE "isDefault" = true AND "deletedAt" IS NULL;

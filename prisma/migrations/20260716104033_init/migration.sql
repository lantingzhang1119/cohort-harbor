-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "workLocation" TEXT NOT NULL DEFAULT 'UNSET',
    "firstDepartment" TEXT,
    "secondDepartment" TEXT,
    "position" TEXT,
    "hiredAt" DATETIME,
    "leftAt" DATETIME,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RosterImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "disabledCount" INTEGER NOT NULL DEFAULT 0,
    "restoredCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "previewPayload" JSONB,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" DATETIME,
    CONSTRAINT "RosterImportBatch_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RosterConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "rowPayload" JSONB NOT NULL,
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    CONSTRAINT "RosterConflict_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RosterImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CityGuide" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GuideChapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guideId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "address" TEXT,
    "contact" TEXT,
    "externalUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "imageAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuideChapter_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "CityGuide" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuideChapter_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "FileAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuideRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guideId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuideRevision_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "CityGuide" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuideRevision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "applicableCities" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "versionNumber" TEXT NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PolicyVersion_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PolicyViewLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyVersionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyViewLog_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PolicyViewLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "passingScore" INTEGER NOT NULL DEFAULT 80,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "dueDaysAfterHire" INTEGER NOT NULL DEFAULT 7,
    "randomizeQuestions" BOOLEAN NOT NULL DEFAULT true,
    "randomizeOptions" BOOLEAN NOT NULL DEFAULT true,
    "showWrongAnswers" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuestionOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "questionId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "QuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "dueAt" DATETIME NOT NULL,
    "allowedAttempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExamAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExamAssignment_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
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
    CONSTRAINT "ExamAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExamAssignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttemptQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "promptSnapshot" TEXT NOT NULL,
    "typeSnapshot" TEXT NOT NULL,
    "scoreSnapshot" INTEGER NOT NULL,
    "optionSnapshot" JSONB NOT NULL,
    "correctOptionKeys" JSONB NOT NULL,
    CONSTRAINT "AttemptQuestion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttemptQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttemptAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedKeys" JSONB NOT NULL,
    "awardedScore" INTEGER,
    "savedAt" DATETIME NOT NULL,
    CONSTRAINT "AttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttemptAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RetakeApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assignmentId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    CONSTRAINT "RetakeApplication_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExamAssignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RetakeApplication_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RetakeApplication_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SimulatedEmailLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIMULATED_NO_SMTP',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SimulatedEmailLog_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SimulatedEmailLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "watermarkOpacity" REAL NOT NULL DEFAULT 0.07,
    "defaultExamMinutes" INTEGER NOT NULL DEFAULT 30,
    "defaultDueDays" INTEGER NOT NULL DEFAULT 7,
    "showWrongAnswers" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "result" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeNo_key" ON "User"("employeeNo");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_name_idx" ON "User"("name");

-- CreateIndex
CREATE INDEX "User_workLocation_idx" ON "User"("workLocation");

-- CreateIndex
CREATE INDEX "User_status_enabled_idx" ON "User"("status", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RosterImportBatch_createdAt_idx" ON "RosterImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "RosterConflict_batchId_type_idx" ON "RosterConflict"("batchId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CityGuide_city_key" ON "CityGuide"("city");

-- CreateIndex
CREATE INDEX "GuideChapter_guideId_sortOrder_idx" ON "GuideChapter"("guideId", "sortOrder");

-- CreateIndex
CREATE INDEX "GuideRevision_guideId_createdAt_idx" ON "GuideRevision"("guideId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_storageKey_key" ON "FileAsset"("storageKey");

-- CreateIndex
CREATE INDEX "Policy_status_sortOrder_idx" ON "Policy"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "Policy_category_idx" ON "Policy"("category");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_policyId_versionNumber_key" ON "PolicyVersion"("policyId", "versionNumber");

-- CreateIndex
CREATE INDEX "PolicyViewLog_userId_viewedAt_idx" ON "PolicyViewLog"("userId", "viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_name_key" ON "Exam"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Question_examId_sequence_key" ON "Question"("examId", "sequence");

-- CreateIndex
CREATE INDEX "QuestionOption_questionId_sortOrder_idx" ON "QuestionOption"("questionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionOption_questionId_optionKey_key" ON "QuestionOption"("questionId", "optionKey");

-- CreateIndex
CREATE INDEX "ExamAssignment_status_dueAt_idx" ON "ExamAssignment"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAssignment_userId_examId_key" ON "ExamAssignment"("userId", "examId");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_expiresAt_idx" ON "ExamAttempt"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_assignmentId_attemptNo_key" ON "ExamAttempt"("assignmentId", "attemptNo");

-- CreateIndex
CREATE INDEX "AttemptQuestion_attemptId_displayOrder_idx" ON "AttemptQuestion"("attemptId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptQuestion_attemptId_questionId_key" ON "AttemptQuestion"("attemptId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptAnswer_attemptId_questionId_key" ON "AttemptAnswer"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "RetakeApplication_status_createdAt_idx" ON "RetakeApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "SimulatedEmailLog_createdAt_idx" ON "SimulatedEmailLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

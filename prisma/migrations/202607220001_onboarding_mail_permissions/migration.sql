-- Safe defaults: migration and seed never enable or enqueue welcome mail.
ALTER TABLE "SystemSetting" ADD COLUMN "onboardingMailAutomationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSetting" ADD COLUMN "onboardingMailAutomationEnabledAt" DATETIME;
ALTER TABLE "SystemSetting" ADD COLUMN "onboardingMailAutomationEnabledById" TEXT;

CREATE TABLE "EmployeeModuleSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedBySnapshot" JSONB,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmployeeModuleSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "EmployeeModuleSetting" ("key", "enabled", "updatedAt") VALUES
    ('GUIDES', true, CURRENT_TIMESTAMP),
    ('ONBOARDING_KIT', true, CURRENT_TIMESTAMP),
    ('POLICIES', true, CURRENT_TIMESTAMP),
    ('EXAM', true, CURRENT_TIMESTAMP),
    ('RESULTS', true, CURRENT_TIMESTAMP),
    ('RETAKE', true, CURRENT_TIMESTAMP),
    ('NOTIFICATIONS', true, CURRENT_TIMESTAMP);

CREATE TABLE "OnboardingMaterial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "createdById" TEXT,
    "createdBySnapshot" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedBySnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OnboardingMaterial_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "OnboardingMaterialVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMaterial_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMaterial_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMaterialVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedBySnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingMaterialVersion_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "OnboardingMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMaterialVersion_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMaterialVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BUILTIN',
    "builtIn" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "dateFormat" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "constantValue" TEXT,
    "updatedById" TEXT,
    "updatedBySnapshot" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OnboardingMailField_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultSendTime" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "draftSenderName" TEXT,
    "draftSubject" TEXT,
    "draftHtmlBody" TEXT,
    "draftTextBody" TEXT,
    "draftFieldConfig" JSONB,
    "draftStyleConfig" JSONB,
    "currentRevisionId" TEXT,
    "updatedById" TEXT,
    "updatedBySnapshot" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OnboardingMailTemplate_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "OnboardingMailTemplateRevision" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailTemplate_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailTemplateRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "senderDisplayName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "htmlBody" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "fieldConfig" JSONB NOT NULL,
    "styleConfig" JSONB NOT NULL,
    "publishedById" TEXT,
    "publishedBySnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingMailTemplateRevision_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OnboardingMailTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailTemplateRevision_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailDraftAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ATTACHMENT',
    "fileAssetId" TEXT,
    "materialVersionId" TEXT,
    "displayName" TEXT NOT NULL,
    "contentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingMailDraftAttachment_exactly_one_source" CHECK (("fileAssetId" IS NOT NULL) <> ("materialVersionId" IS NOT NULL)),
    CONSTRAINT "OnboardingMailDraftAttachment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OnboardingMailTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDraftAttachment_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDraftAttachment_materialVersionId_fkey" FOREIGN KEY ("materialVersionId") REFERENCES "OnboardingMaterialVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailRevisionAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ATTACHMENT',
    "fileAssetId" TEXT,
    "materialVersionId" TEXT,
    "displayName" TEXT NOT NULL,
    "contentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OnboardingMailRevisionAttachment_exactly_one_source" CHECK (("fileAssetId" IS NOT NULL) <> ("materialVersionId" IS NOT NULL)),
    CONSTRAINT "OnboardingMailRevisionAttachment_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "OnboardingMailTemplateRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailRevisionAttachment_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailRevisionAttachment_materialVersionId_fkey" FOREIGN KEY ("materialVersionId") REFERENCES "OnboardingMaterialVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailDraftCc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OnboardingMailDraftCc_valid_target" CHECK (("kind" = 'USER' AND "userId" IS NOT NULL AND "email" IS NULL) OR ("kind" = 'EMAIL' AND "userId" IS NULL AND "email" IS NOT NULL)),
    CONSTRAINT "OnboardingMailDraftCc_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OnboardingMailTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDraftCc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailRevisionCc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "userSnapshot" JSONB,
    "email" TEXT,
    "displayName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OnboardingMailRevisionCc_valid_target" CHECK (("kind" = 'USER' AND ("userId" IS NOT NULL OR "userSnapshot" IS NOT NULL) AND "email" IS NULL) OR ("kind" = 'EMAIL' AND "userId" IS NULL AND "email" IS NOT NULL)),
    CONSTRAINT "OnboardingMailRevisionCc_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "OnboardingMailTemplateRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailRevisionCc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "OnboardingMailDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "recipientId" TEXT,
    "recipientEmailSnapshot" TEXT NOT NULL,
    "recipientSnapshot" JSONB NOT NULL,
    "templateRevisionId" TEXT NOT NULL,
    "templateSnapshot" JSONB NOT NULL,
    "fieldSummary" JSONB NOT NULL,
    "ccSnapshot" JSONB NOT NULL,
    "attachmentSummary" JSONB NOT NULL,
    "scheduledLocalDate" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "dispatchedAt" DATETIME,
    "sentAt" DATETIME,
    "nextRetryAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "workerId" TEXT,
    "leaseExpiresAt" DATETIME,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT,
    "actorSnapshot" JSONB,
    "failureCode" TEXT,
    "errorSummary" TEXT,
    "providerMessageId" TEXT,
    "responseSummary" TEXT,
    "unknownResolution" TEXT,
    "unknownResolvedAt" DATETIME,
    "unknownResolvedById" TEXT,
    "unknownResolverSnapshot" JSONB,
    "unknownResolutionNote" TEXT,
    "resendOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OnboardingMailDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDelivery_templateRevisionId_fkey" FOREIGN KEY ("templateRevisionId") REFERENCES "OnboardingMailTemplateRevision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDelivery_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDelivery_unknownResolvedById_fkey" FOREIGN KEY ("unknownResolvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingMailDelivery_resendOfId_fkey" FOREIGN KEY ("resendOfId") REFERENCES "OnboardingMailDelivery" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OnboardingMaterial_currentVersionId_key" ON "OnboardingMaterial"("currentVersionId");
CREATE INDEX "OnboardingMaterial_status_sortOrder_idx" ON "OnboardingMaterial"("status", "sortOrder");
CREATE INDEX "OnboardingMaterial_category_sortOrder_idx" ON "OnboardingMaterial"("category", "sortOrder");
CREATE UNIQUE INDEX "OnboardingMaterialVersion_fileAssetId_key" ON "OnboardingMaterialVersion"("fileAssetId");
CREATE UNIQUE INDEX "OnboardingMaterialVersion_materialId_versionNumber_key" ON "OnboardingMaterialVersion"("materialId", "versionNumber");
CREATE INDEX "OnboardingMaterialVersion_materialId_createdAt_idx" ON "OnboardingMaterialVersion"("materialId", "createdAt");
CREATE UNIQUE INDEX "OnboardingMailField_key_key" ON "OnboardingMailField"("key");
CREATE INDEX "OnboardingMailField_enabled_sortOrder_idx" ON "OnboardingMailField"("enabled", "sortOrder");
CREATE UNIQUE INDEX "OnboardingMailTemplate_kind_key" ON "OnboardingMailTemplate"("kind");
CREATE UNIQUE INDEX "OnboardingMailTemplate_currentRevisionId_key" ON "OnboardingMailTemplate"("currentRevisionId");
CREATE INDEX "OnboardingMailTemplate_enabled_kind_idx" ON "OnboardingMailTemplate"("enabled", "kind");
CREATE UNIQUE INDEX "OnboardingMailTemplateRevision_templateId_revisionNumber_key" ON "OnboardingMailTemplateRevision"("templateId", "revisionNumber");
CREATE INDEX "OnboardingMailTemplateRevision_templateId_createdAt_idx" ON "OnboardingMailTemplateRevision"("templateId", "createdAt");
CREATE INDEX "OnboardingMailDraftAttachment_templateId_sortOrder_idx" ON "OnboardingMailDraftAttachment"("templateId", "sortOrder");
CREATE INDEX "OnboardingMailDraftAttachment_fileAssetId_idx" ON "OnboardingMailDraftAttachment"("fileAssetId");
CREATE INDEX "OnboardingMailDraftAttachment_materialVersionId_idx" ON "OnboardingMailDraftAttachment"("materialVersionId");
CREATE INDEX "OnboardingMailRevisionAttachment_revisionId_sortOrder_idx" ON "OnboardingMailRevisionAttachment"("revisionId", "sortOrder");
CREATE INDEX "OnboardingMailRevisionAttachment_fileAssetId_idx" ON "OnboardingMailRevisionAttachment"("fileAssetId");
CREATE INDEX "OnboardingMailRevisionAttachment_materialVersionId_idx" ON "OnboardingMailRevisionAttachment"("materialVersionId");
CREATE INDEX "OnboardingMailDraftCc_templateId_sortOrder_idx" ON "OnboardingMailDraftCc"("templateId", "sortOrder");
CREATE INDEX "OnboardingMailDraftCc_userId_idx" ON "OnboardingMailDraftCc"("userId");
CREATE INDEX "OnboardingMailRevisionCc_revisionId_sortOrder_idx" ON "OnboardingMailRevisionCc"("revisionId", "sortOrder");
CREATE INDEX "OnboardingMailRevisionCc_userId_idx" ON "OnboardingMailRevisionCc"("userId");
CREATE UNIQUE INDEX "OnboardingMailDelivery_idempotencyKey_key" ON "OnboardingMailDelivery"("idempotencyKey");
CREATE UNIQUE INDEX "OnboardingMailDelivery_resendOfId_key" ON "OnboardingMailDelivery"("resendOfId");
CREATE INDEX "OnboardingMailDelivery_status_scheduledAt_idx" ON "OnboardingMailDelivery"("status", "scheduledAt");
CREATE INDEX "OnboardingMailDelivery_status_nextRetryAt_idx" ON "OnboardingMailDelivery"("status", "nextRetryAt");
CREATE INDEX "OnboardingMailDelivery_recipientId_createdAt_idx" ON "OnboardingMailDelivery"("recipientId", "createdAt");
CREATE INDEX "OnboardingMailDelivery_templateRevisionId_createdAt_idx" ON "OnboardingMailDelivery"("templateRevisionId", "createdAt");
CREATE INDEX "OnboardingMailDelivery_workerId_leaseGeneration_idx" ON "OnboardingMailDelivery"("workerId", "leaseGeneration");

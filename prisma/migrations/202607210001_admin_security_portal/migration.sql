-- AlterTable
ALTER TABLE "User" ADD COLUMN "adminArchivedAt" DATETIME;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "actorSnapshot" JSONB;
UPDATE "AuditLog"
SET "actorSnapshot" = (
    SELECT json_object(
        'id', "User"."id",
        'employeeNo', "User"."employeeNo",
        'name', "User"."name",
        'role', "User"."role"
    )
    FROM "User"
    WHERE "User"."id" = "AuditLog"."actorId"
)
WHERE "actorId" IS NOT NULL;

-- AlterTable
ALTER TABLE "RetakeApplication" ADD COLUMN "reviewerSnapshot" JSONB;
UPDATE "RetakeApplication"
SET "reviewerSnapshot" = (
    SELECT json_object(
        'id', "User"."id",
        'employeeNo', "User"."employeeNo",
        'name', "User"."name",
        'email', "User"."email",
        'role', "User"."role"
    )
    FROM "User"
    WHERE "User"."id" = "RetakeApplication"."reviewerId"
)
WHERE "reviewerId" IS NOT NULL;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminIdentityHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectAccountId" TEXT NOT NULL,
    "subjectId" TEXT,
    "actorId" TEXT,
    "event" TEXT NOT NULL,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminIdentityHistory_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AdminIdentityHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuidePortalDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "canvasWidth" INTEGER NOT NULL,
    "canvasHeight" INTEGER NOT NULL,
    "elements" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedBySnapshot" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuidePortalDraft_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuidePortalPublication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "canvasWidth" INTEGER NOT NULL,
    "canvasHeight" INTEGER NOT NULL,
    "elements" JSONB NOT NULL,
    "publishedById" TEXT,
    "publishedBySnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuidePortalPublication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Rebuild tables whose actor foreign keys or required snapshot columns changed.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewMode" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("id", "tokenHash", "userId", "viewMode", "expiresAt", "createdAt", "revokedAt")
SELECT
    "Session"."id",
    "Session"."tokenHash",
    "Session"."userId",
    CASE WHEN "User"."role" IN ('SUPER_ADMIN', 'ADMIN') THEN 'ADMIN' ELSE 'EMPLOYEE' END,
    "Session"."expiresAt",
    "Session"."createdAt",
    "Session"."revokedAt"
FROM "Session"
JOIN "User" ON "User"."id" = "Session"."userId";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

CREATE TABLE "new_RosterImportBatch" (
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
    "actorId" TEXT,
    "actorSnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" DATETIME,
    CONSTRAINT "RosterImportBatch_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RosterImportBatch" (
    "id", "sourceName", "originalFileName", "fileHash", "status", "totalRows", "createdCount",
    "updatedCount", "disabledCount", "restoredCount", "skippedCount", "conflictCount", "errorCount",
    "previewPayload", "actorId", "actorSnapshot", "createdAt", "committedAt"
)
SELECT
    batch."id", batch."sourceName", batch."originalFileName", batch."fileHash", batch."status",
    batch."totalRows", batch."createdCount", batch."updatedCount", batch."disabledCount",
    batch."restoredCount", batch."skippedCount", batch."conflictCount", batch."errorCount",
    batch."previewPayload", batch."actorId",
    json_object('id', actor."id", 'employeeNo', actor."employeeNo", 'name', actor."name", 'email', actor."email", 'role', actor."role"),
    batch."createdAt", batch."committedAt"
FROM "RosterImportBatch" AS batch
LEFT JOIN "User" AS actor ON actor."id" = batch."actorId";
DROP TABLE "RosterImportBatch";
ALTER TABLE "new_RosterImportBatch" RENAME TO "RosterImportBatch";
CREATE INDEX "RosterImportBatch_createdAt_idx" ON "RosterImportBatch"("createdAt");

CREATE TABLE "new_GuideRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guideId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorSnapshot" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuideRevision_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "CityGuide" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuideRevision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GuideRevision" ("id", "guideId", "actorId", "actorSnapshot", "summary", "snapshot", "createdAt")
SELECT
    revision."id", revision."guideId", revision."actorId",
    json_object('id', actor."id", 'employeeNo', actor."employeeNo", 'name', actor."name", 'email', actor."email", 'role', actor."role"),
    revision."summary", revision."snapshot", revision."createdAt"
FROM "GuideRevision" AS revision
LEFT JOIN "User" AS actor ON actor."id" = revision."actorId";
DROP TABLE "GuideRevision";
ALTER TABLE "new_GuideRevision" RENAME TO "GuideRevision";
CREATE INDEX "GuideRevision_guideId_createdAt_idx" ON "GuideRevision"("guideId", "createdAt");

CREATE TABLE "new_FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedBySnapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FileAsset" (
    "id", "kind", "storageKey", "originalName", "mimeType", "sizeBytes", "sha256", "uploadedById", "uploadedBySnapshot", "createdAt"
)
SELECT
    asset."id", asset."kind", asset."storageKey", asset."originalName", asset."mimeType", asset."sizeBytes",
    asset."sha256", asset."uploadedById",
    json_object('id', actor."id", 'employeeNo', actor."employeeNo", 'name', actor."name", 'email', actor."email", 'role', actor."role"),
    asset."createdAt"
FROM "FileAsset" AS asset
LEFT JOIN "User" AS actor ON actor."id" = asset."uploadedById";
DROP TABLE "FileAsset";
ALTER TABLE "new_FileAsset" RENAME TO "FileAsset";
CREATE UNIQUE INDEX "FileAsset_storageKey_key" ON "FileAsset"("storageKey");

CREATE TABLE "new_SimulatedEmailLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "recipientSnapshot" JSONB NOT NULL,
    "actorId" TEXT,
    "actorSnapshot" JSONB,
    "templateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIMULATED_NO_SMTP',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SimulatedEmailLog_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SimulatedEmailLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SimulatedEmailLog" (
    "id", "recipientId", "recipientSnapshot", "actorId", "actorSnapshot", "templateKey", "status", "createdAt"
)
SELECT
    mail."id", mail."recipientId",
    json_object('id', recipient."id", 'employeeNo', recipient."employeeNo", 'name', recipient."name", 'email', recipient."email", 'role', recipient."role"),
    mail."actorId",
    CASE WHEN actor."id" IS NULL THEN NULL ELSE json_object('id', actor."id", 'employeeNo', actor."employeeNo", 'name', actor."name", 'email', actor."email", 'role', actor."role") END,
    mail."templateKey", mail."status", mail."createdAt"
FROM "SimulatedEmailLog" AS mail
JOIN "User" AS recipient ON recipient."id" = mail."recipientId"
LEFT JOIN "User" AS actor ON actor."id" = mail."actorId";
DROP TABLE "SimulatedEmailLog";
ALTER TABLE "new_SimulatedEmailLog" RENAME TO "SimulatedEmailLog";
CREATE INDEX "SimulatedEmailLog_createdAt_idx" ON "SimulatedEmailLog"("createdAt");

-- Promote exactly one deterministic eligible administrator only after historical
-- snapshots have captured the roles that were in effect when those events occurred.
UPDATE "User"
SET "role" = 'SUPER_ADMIN'
WHERE "id" = (
    SELECT "id"
    FROM "User"
    WHERE "role" = 'ADMIN'
      AND "enabled" = true
      AND "status" = 'ACTIVE'
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
);

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId", "createdAt");
CREATE INDEX "AdminIdentityHistory_subjectAccountId_createdAt_idx" ON "AdminIdentityHistory"("subjectAccountId", "createdAt");
CREATE UNIQUE INDEX "GuidePortalDraft_city_viewport_key" ON "GuidePortalDraft"("city", "viewport");
CREATE INDEX "GuidePortalPublication_city_viewport_createdAt_idx" ON "GuidePortalPublication"("city", "viewport", "createdAt");
CREATE UNIQUE INDEX "GuidePortalPublication_city_viewport_version_key" ON "GuidePortalPublication"("city", "viewport", "version");

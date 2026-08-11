ALTER TABLE "GuidePortalDraft" ADD COLUMN "sceneVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GuidePortalDraft" ADD COLUMN "scene" JSONB;
ALTER TABLE "GuidePortalDraft" ADD COLUMN "legacyElements" JSONB;
ALTER TABLE "GuidePortalDraft" ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "GuidePortalAssetMetadata" (
    "assetId" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "frameCount" INTEGER,
    "decodedCostBytes" BIGINT,
    "inspectionStatus" TEXT NOT NULL,
    "incompatibilityReason" TEXT,
    "inspectedAt" DATETIME,
    CONSTRAINT "GuidePortalAssetMetadata_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GuidePortalAssetMetadata_category_inspectionStatus_idx" ON "GuidePortalAssetMetadata"("category", "inspectionStatus");

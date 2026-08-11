CREATE TABLE "GuidePortalAssetReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "draftId" TEXT,
    "publicationId" TEXT,
    "elementId" TEXT NOT NULL,
    CONSTRAINT "GuidePortalAssetReference_exactly_one_owner" CHECK (("draftId" IS NOT NULL) <> ("publicationId" IS NOT NULL)),
    CONSTRAINT "GuidePortalAssetReference_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GuidePortalAssetReference_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "GuidePortalDraft" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuidePortalAssetReference_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "GuidePortalPublication" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "GuidePortalAssetReference" ("id", "assetId", "draftId", "publicationId", "elementId")
SELECT lower(hex(randomblob(16))), json_extract(element.value, '$.assetId'), draft."id", NULL, json_extract(element.value, '$.id')
FROM "GuidePortalDraft" AS draft, json_each(draft."elements") AS element;

INSERT INTO "GuidePortalAssetReference" ("id", "assetId", "draftId", "publicationId", "elementId")
SELECT lower(hex(randomblob(16))), json_extract(element.value, '$.assetId'), NULL, publication."id", json_extract(element.value, '$.id')
FROM "GuidePortalPublication" AS publication, json_each(publication."elements") AS element;

CREATE UNIQUE INDEX "GuidePortalAssetReference_draftId_elementId_key" ON "GuidePortalAssetReference"("draftId", "elementId");
CREATE UNIQUE INDEX "GuidePortalAssetReference_publicationId_elementId_key" ON "GuidePortalAssetReference"("publicationId", "elementId");
CREATE INDEX "GuidePortalAssetReference_assetId_idx" ON "GuidePortalAssetReference"("assetId");

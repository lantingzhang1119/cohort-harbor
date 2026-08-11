import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const expectedModels = [
  "User",
  "Session",
  "RosterImportBatch",
  "RosterConflict",
  "CityGuide",
  "GuideChapter",
  "GuideRevision",
  "FileAsset",
  "Policy",
  "PolicyVersion",
  "PolicyViewLog",
  "Exam",
  "Question",
  "QuestionOption",
  "ExamAssignment",
  "ExamAttempt",
  "AttemptQuestion",
  "AttemptAnswer",
  "RetakeApplication",
  "Notification",
  "SimulatedEmailLog",
  "SystemSetting",
  "AuditLog",
  "PasswordResetToken",
  "AdminIdentityHistory",
  "GuidePortalDraft",
  "GuidePortalPublication",
  "GuidePortalAssetMetadata",
  "EmployeeModuleSetting",
  "OnboardingMaterial",
  "OnboardingMaterialVersion",
  "OnboardingMailField",
  "OnboardingMailTemplate",
  "OnboardingMailTemplateRevision",
  "OnboardingMailDraftAttachment",
  "OnboardingMailRevisionAttachment",
  "OnboardingMailDraftCc",
  "OnboardingMailRevisionCc",
  "OnboardingMailDelivery",
] as const;

function modelBlock(schema: string, model: string) {
  const match = schema.match(new RegExp(`model\\s+${model}\\s+\\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing Prisma model ${model}`).not.toBeNull();
  return match![1];
}

function sqliteColumns(table: string) {
  const sqlite = new Database(":memory:");
  const migrationsRoot = join(process.cwd(), "prisma", "migrations");
  for (const migration of readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    sqlite.exec(readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8"));
  }
  const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  sqlite.close();
  return columns.map((column) => column.name);
}

const visualPortalMigration = "202607250001_visual_portal_scene";
const visualPortalPublicationMigration = "202607250002_visual_portal_publication_scene";

describe("Prisma schema contract", () => {
  it("defines every domain model required by the local demo", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    for (const model of expectedModels) {
      expect(schema, `missing Prisma model ${model}`).toMatch(
        new RegExp(`model\\s+${model}\\s+\\{`),
      );
    }
  });

  it("stores additive V1 portal fields on drafts and publications without dropping legacy elements", () => {
    const draftColumns = sqliteColumns("GuidePortalDraft");
    expect(draftColumns).toEqual(expect.arrayContaining([
      "elements", "sceneVersion", "scene", "legacyElements", "draftRevision",
    ]));
    const publicationColumns = sqliteColumns("GuidePortalPublication");
    expect(publicationColumns).toEqual(expect.arrayContaining([
      "elements", "sceneVersion", "scene", "legacyElements",
    ]));
  });

  it("repairs object-shaped V1 publications while preserving V0 JSON and canonical scenes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohort-harbor-portal-publication-repair-"));
    const databasePath = join(directory, "legacy.db");
    const migrationsRoot = join(process.cwd(), "prisma", "migrations");
    const v0Elements = JSON.stringify([{
      id: "legacy-image",
      kind: "IMAGE",
      assetId: "legacy-asset",
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      zIndex: 0,
      altText: "旧图片",
    }]);
    const objectScene = JSON.stringify({
      sceneVersion: 1,
      viewport: "DESKTOP",
      requiresMobileReview: false,
      background: {
        assetId: null,
        fitMode: "COVER",
        positionX: 50,
        positionY: 50,
        backgroundColor: "#FFFFFF",
        locked: false,
      },
      elements: [
        {
          id: "visible-image",
          name: "可见图片",
          type: "IMAGE",
          assetId: "visible-asset",
          altText: "可见图片",
          fitMode: "CONTAIN",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          x: 11,
          y: 12,
          width: 130,
          height: 140,
          rotation: 0,
          opacity: 1,
          zIndex: 2,
          locked: false,
          hidden: false,
        },
        {
          id: "hidden-image",
          name: "隐藏图片",
          type: "IMAGE",
          assetId: "hidden-asset",
          altText: "隐藏图片",
          fitMode: "CONTAIN",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          zIndex: 1,
          locked: false,
          hidden: true,
        },
        {
          id: "transparent-image",
          name: "透明图片",
          type: "IMAGE",
          assetId: "transparent-asset",
          altText: "透明图片",
          fitMode: "CONTAIN",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          x: 5,
          y: 5,
          width: 20,
          height: 20,
          rotation: 0,
          opacity: 0,
          zIndex: 3,
          locked: false,
          hidden: false,
        },
        {
          id: "text",
          name: "文字",
          type: "TEXT",
          text: "不进入旧版图片投影",
          x: 0,
          y: 0,
          width: 100,
          height: 30,
          rotation: 0,
          opacity: 1,
          zIndex: 0,
          locked: false,
          hidden: false,
        },
      ],
    });
    const sqlite = new Database(databasePath);
    try {
      for (const migration of readdirSync(migrationsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name < visualPortalPublicationMigration)
        .map((entry) => entry.name)
        .sort()) {
        sqlite.exec(readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8"));
      }
      const insert = sqlite.prepare(`
        INSERT INTO "GuidePortalPublication"
          ("id", "city", "viewport", "version", "canvasWidth", "canvasHeight", "elements", "publishedBySnapshot")
        VALUES (?, 'SHANGHAI', 'DESKTOP', ?, 1440, 900, ?, '{}')
      `);
      insert.run("legacy-publication", 1, v0Elements);
      insert.run("object-publication", 2, objectScene);

      sqlite.exec(readFileSync(
        join(migrationsRoot, visualPortalPublicationMigration, "migration.sql"),
        "utf8",
      ));

      const legacy = sqlite.prepare(`
        SELECT "elements", "sceneVersion", "scene", "legacyElements"
        FROM "GuidePortalPublication" WHERE "id" = 'legacy-publication'
      `).get() as Record<string, unknown>;
      expect(legacy).toEqual({
        elements: v0Elements,
        sceneVersion: 0,
        scene: null,
        legacyElements: v0Elements,
      });

      const repaired = sqlite.prepare(`
        SELECT "elements", "sceneVersion", "scene", "legacyElements"
        FROM "GuidePortalPublication" WHERE "id" = 'object-publication'
      `).get() as Record<string, unknown>;
      expect(repaired.sceneVersion).toBe(1);
      expect(JSON.parse(String(repaired.scene))).toEqual(JSON.parse(objectScene));
      const expectedProjection = [{
        id: "visible-image",
        kind: "IMAGE",
        assetId: "visible-asset",
        x: 11,
        y: 12,
        width: 130,
        height: 140,
        zIndex: 0,
        altText: "可见图片",
      }];
      expect(JSON.parse(String(repaired.elements))).toEqual(expectedProjection);
      expect(JSON.parse(String(repaired.legacyElements))).toEqual(expectedProjection);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates a disposable legacy draft without changing elements and cascades metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohort-harbor-portal-scene-migration-"));
    const databasePath = join(directory, "legacy.db");
    const migrationsRoot = join(process.cwd(), "prisma", "migrations");
    const legacyElements = JSON.stringify([{ id: "legacy-element", type: "text", text: "保留原数据" }]);
    const sqlite = new Database(databasePath);
    try {
      for (const migration of readdirSync(migrationsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name < visualPortalMigration)
        .map((entry) => entry.name)
        .sort()) {
        sqlite.exec(readFileSync(join(migrationsRoot, migration, "migration.sql"), "utf8"));
      }
      sqlite.prepare(`INSERT INTO "GuidePortalDraft" ("id", "city", "viewport", "canvasWidth", "canvasHeight", "elements", "updatedBySnapshot", "updatedAt") VALUES (?, 'SHANGHAI', 'DESKTOP', 1440, 900, ?, '{}', CURRENT_TIMESTAMP)`).run("legacy-draft", legacyElements);

      sqlite.pragma("foreign_keys = ON");
      sqlite.exec(readFileSync(join(migrationsRoot, visualPortalMigration, "migration.sql"), "utf8"));

      expect(sqlite.prepare(`SELECT "elements", "sceneVersion", "scene", "legacyElements", "draftRevision" FROM "GuidePortalDraft" WHERE "id" = 'legacy-draft'`).get()).toEqual({
        elements: legacyElements,
        sceneVersion: 0,
        scene: null,
        legacyElements: null,
        draftRevision: 0,
      });
      const metadataColumns = sqlite.prepare(`PRAGMA table_info("GuidePortalAssetMetadata")`).all() as Array<{ name: string; notnull: number; pk: number }>;
      expect(metadataColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "assetId", pk: 1 }),
        expect.objectContaining({ name: "width", notnull: 0 }),
        expect.objectContaining({ name: "height", notnull: 0 }),
        expect.objectContaining({ name: "incompatibilityReason", notnull: 0 }),
        expect.objectContaining({ name: "inspectedAt", notnull: 0 }),
      ]));
      expect(sqlite.prepare(`PRAGMA index_list("GuidePortalAssetMetadata")`).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "GuidePortalAssetMetadata_category_inspectionStatus_idx" }),
      ]));

      sqlite.prepare(`INSERT INTO "FileAsset" ("id", "kind", "storageKey", "originalName", "mimeType", "sizeBytes", "sha256", "uploadedBySnapshot", "createdAt") VALUES ('metadata-asset', 'PORTAL_IMAGE', 'portal/metadata-asset', 'metadata.png', 'image/png', 4, 'hash', '{}', CURRENT_TIMESTAMP)`).run();
      sqlite.prepare(`INSERT INTO "GuidePortalAssetMetadata" ("assetId", "category", "inspectionStatus") VALUES ('metadata-asset', 'HERO', 'VALID')`).run();
      expect(() => sqlite.prepare(`INSERT INTO "GuidePortalAssetMetadata" ("assetId", "category", "inspectionStatus") VALUES ('metadata-asset', 'HERO', 'VALID')`).run()).toThrow();
      sqlite.prepare(`DELETE FROM "FileAsset" WHERE "id" = 'metadata-asset'`).run();
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "GuidePortalAssetMetadata"`).get()).toEqual({ count: 0 });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defines the complete onboarding and mail safety state machine", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    for (const [name, values] of [
      ["EmployeeModuleKey", ["GUIDES", "ONBOARDING_KIT", "POLICIES", "EXAM", "RESULTS", "RETAKE", "NOTIFICATIONS"]],
      ["OnboardingMaterialStatus", ["DRAFT", "PUBLISHED", "ARCHIVED"]],
      ["OnboardingMailDeliveryStatus", ["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED", "UNKNOWN"]],
      ["OnboardingMailDeliverySource", ["AUTOMATIC", "MANUAL", "TEST", "RESEND"]],
    ] as const) {
      const block = schema.match(new RegExp(`enum\\s+${name}\\s+\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
      for (const value of values) expect(block, `${name}.${value}`).toContain(value);
    }
    expect(schema).toMatch(/enum\s+FileAssetKind\s+\{[\s\S]*?ONBOARDING_MATERIAL[\s\S]*?ONBOARDING_EMAIL_ASSET[\s\S]*?\}/);
    expect(modelBlock(schema, "OnboardingMailDelivery")).toMatch(/idempotencyKey\s+String\?\s+@unique/);
    expect(modelBlock(schema, "OnboardingMailDelivery")).toMatch(/dispatchedAt\s+DateTime\?/);
    expect(modelBlock(schema, "OnboardingMailDelivery")).toMatch(/providerMessageId\s+String\?/);
    expect(modelBlock(schema, "OnboardingMailDelivery")).toMatch(/leaseGeneration\s+Int\s+@default\(0\)/);
    expect(modelBlock(schema, "SystemSetting")).toMatch(/onboardingMailAutomationEnabled\s+Boolean\s+@default\(false\)/);
    expect(modelBlock(schema, "SystemSetting")).toMatch(/onboardingMailAutomationEnabledAt\s+DateTime\?/);
  });

  it("enforces the key uniqueness constraints", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    expect(schema).toMatch(/employeeNo\s+String\s+@unique/);
    expect(schema).toMatch(/@@unique\(\[assignmentId, attemptNo\]\)/);
    expect(schema).toMatch(/@@unique\(\[attemptId, questionId\]\)/);
    expect(modelBlock(schema, "GuidePortalDraft")).toMatch(
      /@@unique\(\[city, viewport\]\)/,
    );
    expect(modelBlock(schema, "GuidePortalPublication")).toMatch(
      /@@unique\(\[city, viewport, version\]\)/,
    );
  });

  it("defines the administrator security and portal enums", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    expect(schema).toMatch(/enum\s+Role\s+\{[\s\S]*?SUPER_ADMIN[\s\S]*?ADMIN[\s\S]*?EMPLOYEE[\s\S]*?\}/);
    expect(schema).toMatch(/enum\s+SessionViewMode\s+\{[\s\S]*?ADMIN[\s\S]*?EMPLOYEE[\s\S]*?\}/);
    expect(schema).toMatch(/enum\s+AdminIdentityEvent\s+\{[\s\S]*?CREATED[\s\S]*?TRANSFERRED[\s\S]*?ARCHIVED[\s\S]*?RESTORED[\s\S]*?PERMANENTLY_DELETED[\s\S]*?\}/);
    expect(schema).toMatch(/enum\s+PortalViewport\s+\{[\s\S]*?DESKTOP[\s\S]*?MOBILE[\s\S]*?\}/);
    expect(schema).toMatch(/enum\s+FileAssetKind\s+\{[\s\S]*?PORTAL_IMAGE[\s\S]*?\}/);
  });

  it("stores session mode, administrator lifecycle data, and immutable identity snapshots", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    expect(modelBlock(schema, "User")).toMatch(/adminArchivedAt\s+DateTime\?/);
    expect(modelBlock(schema, "Session")).toMatch(
      /viewMode\s+SessionViewMode\s+@default\(EMPLOYEE\)/,
    );
    expect(modelBlock(schema, "AuditLog")).toMatch(/actorSnapshot\s+Json\?/);
    expect(modelBlock(schema, "RosterImportBatch")).toMatch(/actorSnapshot\s+Json\b/);
    expect(modelBlock(schema, "GuideRevision")).toMatch(/actorSnapshot\s+Json\b/);
    expect(modelBlock(schema, "FileAsset")).toMatch(/uploadedBySnapshot\s+Json\b/);
    expect(modelBlock(schema, "RetakeApplication")).toMatch(/reviewerSnapshot\s+Json\?/);
    expect(modelBlock(schema, "SimulatedEmailLog")).toMatch(/recipientSnapshot\s+Json\b/);
    expect(modelBlock(schema, "SimulatedEmailLog")).toMatch(/actorSnapshot\s+Json\?/);
    expect(modelBlock(schema, "PasswordResetToken")).toMatch(/deliveredAt\s+DateTime\?/);
    expect(modelBlock(schema, "PasswordResetToken")).toMatch(/deliveryFailedAt\s+DateTime\?/);
  });

  it("keeps administrator actor history after account deletion", async () => {
    const schema = await readFile(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

    for (const [model, field, relation] of [
      ["RosterImportBatch", "actorId", "RosterImportActor"],
      ["GuideRevision", "actorId", "GuideRevisionActor"],
      ["FileAsset", "uploadedById", "FileUploadActor"],
      ["RetakeApplication", "reviewerId", "RetakeReviewer"],
      ["SimulatedEmailLog", "actorId", "SimulatedEmailActor"],
    ] as const) {
      const block = modelBlock(schema, model);
      expect(block).toMatch(new RegExp(`${field}\\s+String\\?`));
      expect(block).toMatch(
        new RegExp(`@relation\\("${relation}"[\\s\\S]*?onDelete:\\s*SetNull\\)`),
      );
    }
  });
});

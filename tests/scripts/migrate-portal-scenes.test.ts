import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { defaultPortalScene } from "@/features/portal/portal-scene";
import {
  runPortalSceneMigration,
  type PortalSceneMigrationHooks,
} from "../../scripts/migrate-portal-scenes";
import { validPng } from "../fixtures/portal-images";

const CITIES = ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"] as const;
const VIEWPORTS = ["DESKTOP", "MOBILE"] as const;

describe("portal scene V1 data migration", () => {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("requires explicit real non-symlink paths and completed portal DDL migrations", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await expect(runPortalSceneMigration({
      databasePath: path.relative(process.cwd(), fixture.databasePath),
      privateRoot: fixture.privateRoot,
      dryRun: true,
    })).rejects.toThrow(/absolute/i);

    const linkPath = path.join(fixture.directory, "database-link.db");
    await symlink(fixture.databasePath, linkPath);
    await expect(runPortalSceneMigration({
      databasePath: linkPath,
      privateRoot: fixture.privateRoot,
      dryRun: true,
    })).rejects.toThrow(/symlink/i);

    fixture.db.prepare(
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '202607250002_visual_portal_publication_scene'`,
    ).run();
    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: true,
    })).rejects.toThrow(/202607250002_visual_portal_publication_scene/);
  });

  it("keeps an empty database byte-identical in dry-run and creates no backup or audit", async () => {
    const fixture = await createFixture(cleanupDirectories);
    fixture.db.close();
    const before = sha256(readFileSync(fixture.databasePath));
    const filesBefore = readdirSync(fixture.directory).sort();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: true,
    });

    expect(report).toMatchObject({
      status: "DRY_RUN",
      convertedDrafts: 0,
      convertedPublications: 0,
      fallbackPublicationPairs: 0,
      metadataChanges: 0,
      referenceChanges: 0,
      backupFile: null,
      auditFile: null,
    });
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(readdirSync(fixture.directory).sort()).toEqual(filesBefore);
    expect(report.latestMatrix).toHaveLength(8);
    expect(report.latestMatrix.every(({ status }) => status === "NO_PUBLICATION")).toBe(true);
  });

  it("converts all four complete legacy viewport pairs atomically, rebuilds private references and is idempotent", async () => {
    const fixture = await createFixture(cleanupDirectories);
    const originalElements = new Map<string, string>();
    for (const city of CITIES) {
      for (const viewport of VIEWPORTS) {
        const assetId = `${city.toLowerCase()}-${viewport.toLowerCase()}`;
        await createAsset(fixture, assetId);
        const elements = legacyElements(
          assetId,
          `${city}-${viewport}-employee-private`,
          city === "SHANGHAI" && viewport === "DESKTOP" ? "LOGO" : "IMAGE",
        );
        originalElements.set(`${city}:${viewport}`, JSON.stringify(elements));
        insertLegacyPublication(fixture.db, city, viewport, 7, elements);
        insertLegacyDraft(fixture.db, city, viewport, elements);
      }
    }
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });

    expect(report).toMatchObject({
      status: "MIGRATED",
      convertedDrafts: 8,
      convertedPublications: 8,
      fallbackPublicationPairs: 0,
      metadataChanges: 8,
      backupFile: expect.stringMatching(/^portal-scene-v1-.*\.backup\.sqlite$/),
      backupSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      auditFile: expect.stringMatching(/^portal-scene-v1-.*\.json$/),
    });
    expect(report.latestMatrix.every(({ status }) => status === "V1")).toBe(true);

    const migrated = new Database(fixture.databasePath, { readonly: true });
    try {
      const publications = migrated.prepare(
        `SELECT "city", "viewport", "version", "sceneVersion", "scene", "elements", "legacyElements"
         FROM "GuidePortalPublication" ORDER BY "city", "viewport"`,
      ).all() as Array<Record<string, string | number>>;
      expect(publications).toHaveLength(8);
      for (const row of publications) {
        const key = `${row.city}:${row.viewport}`;
        expect(row.version).toBe(7);
        expect(row.sceneVersion).toBe(1);
        expect(row.elements).toBe(originalElements.get(key));
        expect(row.legacyElements).toBe(originalElements.get(key));
        expect(JSON.parse(String(row.scene))).toMatchObject({
          sceneVersion: 1,
          viewport: row.viewport,
        });
      }
      const drafts = migrated.prepare(
        `SELECT "sceneVersion", "draftRevision", "legacyElements" FROM "GuidePortalDraft"`,
      ).all() as Array<{ sceneVersion: number; draftRevision: number; legacyElements: string }>;
      expect(drafts).toHaveLength(8);
      expect(drafts.every((row) =>
        row.sceneVersion === 1 && row.draftRevision === 1 && row.legacyElements !== null
      )).toBe(true);
      expect(
        (migrated.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetReference"`)
          .get() as { count: number }).count,
      ).toBe(16);
      expect(
        (migrated.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata" WHERE "inspectionStatus" = 'VALID'`,
        ).get() as { count: number }).count,
      ).toBe(8);
      expect(
        (migrated.prepare(
          `SELECT "category" FROM "GuidePortalAssetMetadata"
           WHERE "assetId" = 'shanghai-desktop'`,
        ).get() as { category: string }).category,
      ).toBe("LOGO");
      expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }

    const backupPath = path.join(fixture.directory, report.backupFile!);
    expect(sha256(readFileSync(backupPath))).toBe(report.backupSha256);
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(
        (backup.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 0`,
        ).get() as { count: number }).count,
      ).toBe(8);
    } finally {
      backup.close();
    }
    const audit = await readFile(path.join(fixture.directory, report.auditFile!), "utf8");
    expect(audit).not.toContain(fixture.privateRoot);
    expect(audit).not.toContain("employee-private");
    expect(JSON.parse(audit)).toMatchObject({
      status: "MIGRATED",
      convertedDrafts: 8,
      convertedPublications: 8,
    });

    const rerun = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(rerun).toMatchObject({
      status: "NOOP",
      convertedDrafts: 0,
      convertedPublications: 0,
      metadataChanges: 0,
      referenceChanges: 0,
      backupFile: null,
      auditFile: null,
    });
    const rerunDb = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (rerunDb.prepare(`SELECT MAX("draftRevision") AS "revision" FROM "GuidePortalDraft"`)
          .get() as { revision: number }).revision,
      ).toBe(1);
      expect(
        (rerunDb.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetReference"`)
          .get() as { count: number }).count,
      ).toBe(16);
    } finally {
      rerunDb.close();
    }
  });

  it("keeps an unsafe complete pair and an incomplete legacy publication on v0 fallback", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "safe-desktop");
    await createAsset(fixture, "missing-mobile", { writeBytes: false });
    insertLegacyPublication(
      fixture.db,
      "SHENZHEN",
      "DESKTOP",
      1,
      legacyElements("safe-desktop", "safe"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHENZHEN",
      "MOBILE",
      1,
      legacyElements("missing-mobile", "missing"),
    );
    await createAsset(fixture, "half-desktop");
    insertLegacyPublication(
      fixture.db,
      "CHANGSHA",
      "DESKTOP",
      2,
      legacyElements("half-desktop", "half"),
    );
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(report.status).toBe("COMPLETED_WITH_FALLBACK");
    expect(report.convertedPublications).toBe(0);
    expect(report.fallbackPublicationPairs).toBe(2);
    expect(report.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "ASSET_FILE_MISSING",
      "INCOMPLETE_LEGACY_PAIR",
    ]));

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 0`,
        ).get() as { count: number }).count,
      ).toBe(3);
      expect(
        (db.prepare(
          `SELECT "inspectionStatus" FROM "GuidePortalAssetMetadata" WHERE "assetId" = 'missing-mobile'`,
        ).get() as { inspectionStatus: string }).inspectionStatus,
      ).toBe("LEGACY_UNINSPECTED");
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetReference"
           WHERE "publicationId" IS NOT NULL`,
        ).get() as { count: number }).count,
      ).toBe(3);
    } finally {
      db.close();
    }
  });

  it("does not manufacture metadata or references for a missing asset record", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "known-mobile");
    insertLegacyPublication(
      fixture.db,
      "XIAN",
      "DESKTOP",
      6,
      legacyElements("missing-record", "missing record"),
    );
    insertLegacyPublication(
      fixture.db,
      "XIAN",
      "MOBILE",
      6,
      legacyElements("known-mobile", "known"),
    );
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(report.status).toBe("COMPLETED_WITH_FALLBACK");
    expect(report.findings.map(({ code }) => code)).toContain("ASSET_RECORD_MISSING");
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"
           WHERE "assetId" = 'missing-record'`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetReference"
           WHERE "assetId" = 'missing-record'`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication"
           WHERE "city" = 'XIAN' AND "version" = 6 AND "sceneVersion" = 0`,
        ).get() as { count: number }).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("keeps an empty legacy publication pair on v0 so employee chapters are not suppressed", async () => {
    const fixture = await createFixture(cleanupDirectories);
    insertLegacyPublication(fixture.db, "SHANGHAI", "DESKTOP", 8, []);
    insertLegacyPublication(fixture.db, "SHANGHAI", "MOBILE", 8, []);
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(report).toMatchObject({
      status: "COMPLETED_WITH_FALLBACK",
      convertedPublications: 0,
      fallbackPublicationPairs: 1,
      backupFile: null,
    });
    expect(report.findings.map(({ code }) => code)).toContain("LEGACY_ROW_EMPTY");
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication"
           WHERE "city" = 'SHANGHAI' AND "version" = 8 AND "sceneVersion" = 0`,
        ).get() as { count: number }).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rejects mixed V1/v0 or invalid V1 publication pairs before backup or writes", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "mixed");
    const legacy = legacyElements("mixed", "mixed");
    insertLegacyPublication(fixture.db, "XIAN", "MOBILE", 3, legacy);
    insertV1Publication(fixture.db, "XIAN", "DESKTOP", 3, "mixed");
    fixture.db.close();
    const filesBefore = readdirSync(fixture.directory).sort();
    const before = sha256(readFileSync(fixture.databasePath));

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    })).rejects.toThrow(/mixed|V1.*v0|成对/i);
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(readdirSync(fixture.directory).sort()).toEqual(filesBefore);
  });

  it("does not delete existing references for malformed legacy rows", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "malformed-asset");
    fixture.db.prepare(
      `INSERT INTO "GuidePortalPublication" (
         "id", "city", "viewport", "version", "canvasWidth", "canvasHeight",
         "elements", "publishedBySnapshot", "createdAt"
       ) VALUES ('malformed-publication', 'SHANGHAI', 'DESKTOP', 9, 1440, 900, ?, '{}', CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify([{ invalid: true }]));
    fixture.db.prepare(
      `INSERT INTO "GuidePortalAssetReference" (
         "id", "assetId", "publicationId", "elementId"
       ) VALUES ('existing-malformed-reference', 'malformed-asset', 'malformed-publication', 'legacy-safe-reference')`,
    ).run();
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(report.status).toBe("COMPLETED_WITH_FALLBACK");
    expect(report.findings.map(({ code }) => code)).toContain("LEGACY_ROW_INVALID");
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetReference"
           WHERE "id" = 'existing-malformed-reference'`,
        ).get() as { count: number }).count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rolls back every mutation after an injected transactional failure and retains the validated backup", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "rollback-desktop");
    await createAsset(fixture, "rollback-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      4,
      legacyElements("rollback-desktop", "rollback"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      4,
      legacyElements("rollback-mobile", "rollback"),
    );
    fixture.db.close();

    const hooks: PortalSceneMigrationHooks = {
      afterFirstMutation: () => {
        throw new Error("injected-transaction-failure");
      },
    };
    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, hooks)).rejects.toThrow("injected-transaction-failure");

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 0`,
        ).get() as { count: number }).count,
      ).toBe(2);
      expect(
        (db.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"`)
          .get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
    const backups = readdirSync(fixture.directory).filter((name) =>
      name.endsWith(".backup.sqlite")
    );
    expect(backups).toHaveLength(1);
    const backupPath = path.join(fixture.directory, backups[0]!);
    const backupDetails = lstatSync(backupPath);
    expect(backupDetails.isFile()).toBe(true);
    expect(backupDetails.isSymbolicLink()).toBe(false);
    expect(backupDetails.mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      backup.close();
    }
  });

  it("removes an owned backup made world-readable before a pre-COMMIT failure", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "unsafe-backup-failure-desktop");
    await createAsset(fixture, "unsafe-backup-failure-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      23,
      legacyElements("unsafe-backup-failure-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      23,
      legacyElements("unsafe-backup-failure-mobile", "mobile"),
    );
    fixture.db.close();

    let backupPath = "";
    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      backupTargetReserved: (reservedPath) => {
        backupPath = reservedPath;
      },
      afterFirstMutation: () => {
        chmodSync(backupPath, 0o644);
        throw new Error("injected-insecure-backup-transaction-failure");
      },
    })).rejects.toThrow("injected-insecure-backup-transaction-failure");

    expect(backupPath).not.toBe("");
    expect(
      readdirSync(fixture.directory).filter((name) => name.endsWith(".backup.sqlite")),
    ).toEqual([]);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rechecks backup identity and 0600 mode immediately before COMMIT", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "unsafe-backup-commit-desktop");
    await createAsset(fixture, "unsafe-backup-commit-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      24,
      legacyElements("unsafe-backup-commit-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      24,
      legacyElements("unsafe-backup-commit-mobile", "mobile"),
    );
    fixture.db.close();

    let backupPath = "";
    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      backupTargetReserved: (reservedPath) => {
        backupPath = reservedPath;
      },
      beforeCommit: () => {
        chmodSync(backupPath, 0o644);
      },
    })).rejects.toThrow(/backup|0600|secure|changed/i);

    expect(backupPath).not.toBe("");
    expect(
      readdirSync(fixture.directory).filter((name) => name.endsWith(".backup.sqlite")),
    ).toEqual([]);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps the reserved backup a 0600 regular non-symlink file throughout SQLite copy", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "backup-mode-desktop");
    await createAsset(fixture, "backup-mode-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      18,
      legacyElements("backup-mode-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      18,
      legacyElements("backup-mode-mobile", "mobile"),
    );
    fixture.db.close();

    const observedModes: number[] = [];
    let reservedCount = 0;
    let progressCount = 0;
    const assertSecureBackup = (backupPath: string) => {
      const details = lstatSync(backupPath);
      expect(details.isFile()).toBe(true);
      expect(details.isSymbolicLink()).toBe(false);
      expect(details.mode & 0o777).toBe(0o600);
      observedModes.push(details.mode & 0o777);
    };

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      backupTargetReserved: (backupPath) => {
        reservedCount += 1;
        assertSecureBackup(backupPath);
      },
      backupProgress: (backupPath) => {
        progressCount += 1;
        assertSecureBackup(backupPath);
      },
    });

    expect(report.status).toBe("MIGRATED");
    expect(reservedCount).toBe(1);
    expect(progressCount).toBeGreaterThan(0);
    expect(observedModes.every((mode) => mode === 0o600)).toBe(true);
  });

  it("removes its partial secure backup when SQLite copy fails", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "backup-failure-desktop");
    await createAsset(fixture, "backup-failure-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      19,
      legacyElements("backup-failure-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      19,
      legacyElements("backup-failure-mobile", "mobile"),
    );
    fixture.db.close();

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      backupProgress: () => {
        throw new Error("injected-backup-copy-failure");
      },
    })).rejects.toThrow("injected-backup-copy-failure");

    expect(
      readdirSync(fixture.directory).filter((name) => name.endsWith(".backup.sqlite")),
    ).toEqual([]);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("removes the reserved backup when post-copy validation fails", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "backup-validation-desktop");
    await createAsset(fixture, "backup-validation-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      22,
      legacyElements("backup-validation-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      22,
      legacyElements("backup-validation-mobile", "mobile"),
    );
    fixture.db.close();

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      afterBackupCopy: async (backupPath) => {
        await writeFile(backupPath, "not-a-sqlite-backup");
      },
    })).rejects.toThrow(/database|sqlite|malformed|integrity/i);

    expect(
      readdirSync(fixture.directory).filter((name) => name.endsWith(".backup.sqlite")),
    ).toEqual([]);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("atomically rejects pre-existing regular files and symlinks at the backup target", async () => {
    for (const targetKind of ["regular", "symlink"] as const) {
      const fixture = await createFixture(cleanupDirectories);
      await createAsset(fixture, `backup-collision-${targetKind}-desktop`);
      await createAsset(fixture, `backup-collision-${targetKind}-mobile`);
      insertLegacyPublication(
        fixture.db,
        "SHANGHAI",
        "DESKTOP",
        targetKind === "regular" ? 20 : 21,
        legacyElements(`backup-collision-${targetKind}-desktop`, "desktop"),
      );
      insertLegacyPublication(
        fixture.db,
        "SHANGHAI",
        "MOBILE",
        targetKind === "regular" ? 20 : 21,
        legacyElements(`backup-collision-${targetKind}-mobile`, "mobile"),
      );
      fixture.db.close();

      const sentinelPath = path.join(fixture.directory, `${targetKind}-sentinel.txt`);
      await writeFile(sentinelPath, "sentinel-do-not-overwrite");
      let collisionPath = "";
      await expect(runPortalSceneMigration({
        databasePath: fixture.databasePath,
        privateRoot: fixture.privateRoot,
        dryRun: false,
      }, {
        beforeBackupReservation: async (backupPath) => {
          collisionPath = backupPath;
          if (targetKind === "regular") {
            await writeFile(backupPath, "pre-existing");
          } else {
            await symlink(sentinelPath, backupPath);
          }
        },
      })).rejects.toThrow(/exist|overwrite|backup/i);

      expect(collisionPath).not.toBe("");
      expect(await readFile(sentinelPath, "utf8")).toBe("sentinel-do-not-overwrite");
      const collisionDetails = lstatSync(collisionPath);
      expect(collisionDetails.isSymbolicLink()).toBe(targetKind === "symlink");
      if (targetKind === "regular") {
        expect(await readFile(collisionPath, "utf8")).toBe("pre-existing");
      }
      const db = new Database(fixture.databasePath, { readonly: true });
      try {
        expect(
          (db.prepare(
            `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
          ).get() as { count: number }).count,
        ).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  it("detects a data fingerprint race before beginning mutations", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "race-desktop");
    await createAsset(fixture, "race-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      5,
      legacyElements("race-desktop", "race"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      5,
      legacyElements("race-mobile", "race"),
    );
    fixture.db.close();

    const hooks: PortalSceneMigrationHooks = {
      beforeWriteTransaction: () => {
        const concurrent = new Database(fixture.databasePath);
        try {
          concurrent.prepare(
            `UPDATE "GuidePortalPublication" SET "publishedBySnapshot" = '{"changed":true}'
             WHERE "id" = 'publication-SHANGHAI-DESKTOP-5'`,
          ).run();
        } finally {
          concurrent.close();
        }
      },
    };
    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, hooks)).rejects.toThrow(/changed|fingerprint|concurrent/i);

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"`)
          .get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("builds the plan from one read snapshot when concurrent data changes B then returns to A", async () => {
    const fixture = await createFixture(cleanupDirectories);
    fixture.db.pragma("journal_mode = WAL");
    await createAsset(fixture, "snapshot-desktop");
    await createAsset(fixture, "snapshot-mobile");
    const desktopA = legacyElements("snapshot-desktop", "snapshot-A");
    const desktopB = legacyElements("snapshot-desktop", "snapshot-B");
    insertLegacyPublication(fixture.db, "SHANGHAI", "DESKTOP", 11, desktopA);
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      11,
      legacyElements("snapshot-mobile", "snapshot-mobile"),
    );
    fixture.db.close();

    let snapshotMutationCount = 0;
    let restoreCount = 0;
    const hooks: PortalSceneMigrationHooks = {
      afterSnapshotFingerprint: () => {
        snapshotMutationCount += 1;
        const concurrent = new Database(fixture.databasePath);
        try {
          concurrent.prepare(
            `UPDATE "GuidePortalPublication" SET "elements" = ?
             WHERE "id" = 'publication-SHANGHAI-DESKTOP-11'`,
          ).run(JSON.stringify(desktopB));
        } finally {
          concurrent.close();
        }
      },
      beforeWriteTransaction: () => {
        restoreCount += 1;
        const concurrent = new Database(fixture.databasePath);
        try {
          concurrent.prepare(
            `UPDATE "GuidePortalPublication" SET "elements" = ?
             WHERE "id" = 'publication-SHANGHAI-DESKTOP-11'`,
          ).run(JSON.stringify(desktopA));
        } finally {
          concurrent.close();
        }
      },
    };

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, hooks);

    expect(report.status).toBe("MIGRATED");
    expect(snapshotMutationCount).toBe(1);
    expect(restoreCount).toBe(1);
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT "scene" FROM "GuidePortalPublication"
         WHERE "id" = 'publication-SHANGHAI-DESKTOP-11'`,
      ).get() as { scene: string };
      expect(JSON.parse(row.scene).elements[0].altText).toBe("snapshot-A");
    } finally {
      db.close();
    }
  });

  it("rejects a concurrent B state that remains after the plan snapshot", async () => {
    const fixture = await createFixture(cleanupDirectories);
    fixture.db.pragma("journal_mode = WAL");
    await createAsset(fixture, "snapshot-race-desktop");
    await createAsset(fixture, "snapshot-race-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      12,
      legacyElements("snapshot-race-desktop", "snapshot-A"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      12,
      legacyElements("snapshot-race-mobile", "snapshot-mobile"),
    );
    fixture.db.close();

    const hooks: PortalSceneMigrationHooks = {
      afterSnapshotFingerprint: () => {
        const concurrent = new Database(fixture.databasePath);
        try {
          concurrent.prepare(
            `UPDATE "GuidePortalPublication" SET "elements" = ?
             WHERE "id" = 'publication-SHANGHAI-DESKTOP-12'`,
          ).run(JSON.stringify(legacyElements("snapshot-race-desktop", "snapshot-B")));
        } finally {
          concurrent.close();
        }
      },
    };

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, hooks)).rejects.toThrow(/changed|fingerprint|concurrent/i);

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"`)
          .get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back without VALID metadata or V1 scenes when a file changes after inspection", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "toctou-desktop");
    await createAsset(fixture, "toctou-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      13,
      legacyElements("toctou-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      13,
      legacyElements("toctou-mobile", "mobile"),
    );
    fixture.db.close();

    const hooks: PortalSceneMigrationHooks = {
      beforeWriteTransaction: async () => {
        const target = path.join(fixture.privateRoot, "portal/toctou-desktop.png");
        const original = await readFile(target);
        await writeFile(target, Buffer.alloc(original.byteLength, 0x41));
      },
    };

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, hooks)).rejects.toThrow(/asset|file|inspection|changed/i);

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"
           WHERE "inspectionStatus" = 'VALID'`,
        ).get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("revalidates files after the pending audit is durable and immediately before COMMIT", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "commit-window-desktop");
    await createAsset(fixture, "commit-window-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      17,
      legacyElements("commit-window-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      17,
      legacyElements("commit-window-mobile", "mobile"),
    );
    fixture.db.close();

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      beforeCommit: async () => {
        const target = path.join(
          fixture.privateRoot,
          "portal/commit-window-desktop.png",
        );
        const original = await readFile(target);
        await writeFile(target, Buffer.alloc(original.byteLength, 0x42));
      },
    })).rejects.toThrow(/asset|file|inspection|changed/i);

    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(0);
      expect(
        (db.prepare(`SELECT COUNT(*) AS "count" FROM "GuidePortalAssetMetadata"`)
          .get() as { count: number }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("returns a committed audit warning and finalizes the pending audit idempotently on rerun", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "audit-desktop");
    await createAsset(fixture, "audit-mobile");
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      14,
      legacyElements("audit-desktop", "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      14,
      legacyElements("audit-mobile", "mobile"),
    );
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    }, {
      beforeAuditFinalize: () => {
        throw new Error("injected-audit-finalize-failure");
      },
    });

    expect(report).toMatchObject({
      status: "COMMITTED_WITH_AUDIT_WARNING",
      auditState: "PENDING",
      auditWarning: "AUDIT_FINALIZE_FAILED",
      auditFile: expect.stringMatching(/^portal-scene-v1-.*\.json$/),
    });
    const db = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(
        (db.prepare(
          `SELECT COUNT(*) AS "count" FROM "GuidePortalPublication" WHERE "sceneVersion" = 1`,
        ).get() as { count: number }).count,
      ).toBe(2);
    } finally {
      db.close();
    }
    const auditPath = path.join(fixture.directory, report.auditFile!);
    expect(JSON.parse(await readFile(auditPath, "utf8"))).toMatchObject({
      state: "PENDING",
      targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const rerun = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    expect(rerun.status).toBe("NOOP");
    expect(JSON.parse(await readFile(auditPath, "utf8"))).toMatchObject({
      status: "MIGRATED",
      auditState: "COMMITTED",
    });
  });

  it("ignores malformed pending audit JSON shapes instead of blocking an idempotent run", async () => {
    const fixture = await createFixture(cleanupDirectories);
    fixture.db.close();
    const malformedAuditPath = path.join(
      fixture.directory,
      "portal-scene-v1-20260725000000-deadbeef.json",
    );
    const malformedAuditFile = path.basename(malformedAuditPath);
    await writeFile(malformedAuditPath, JSON.stringify({
      protocolVersion: 1,
      state: "PENDING",
      sourceFingerprint: "a".repeat(64),
      targetFingerprint: "b".repeat(64),
      report: { auditFile: malformedAuditFile },
    }));

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });

    expect(report.status).toBe("NOOP");
    expect(JSON.parse(await readFile(malformedAuditPath, "utf8"))).toMatchObject({
      state: "PENDING",
      report: { auditFile: malformedAuditFile },
    });
  });

  it("hashes PII-shaped asset identifiers and never exposes the database basename", async () => {
    const databaseName = "示例员工-personal-portal.db";
    const fixture = await createFixture(cleanupDirectories, databaseName);
    const piiAssetId = "alice@example.test";
    await createAsset(fixture, piiAssetId, { writeBytes: false });
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "DESKTOP",
      15,
      legacyElements(piiAssetId, "desktop"),
    );
    insertLegacyPublication(
      fixture.db,
      "SHANGHAI",
      "MOBILE",
      15,
      legacyElements(piiAssetId, "mobile"),
    );
    fixture.db.close();

    const report = await runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    });
    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain(piiAssetId);
    expect(serializedReport).not.toContain(databaseName);
    expect(report.backupFile).toMatch(/^portal-scene-v1-.*\.backup\.sqlite$/);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ASSET_FILE_MISSING",
        assetRef: expect.stringMatching(/^[a-f0-9]{16}$/),
      }),
    ]));
    const audit = await readFile(path.join(fixture.directory, report.auditFile!), "utf8");
    expect(audit).not.toContain(piiAssetId);
    expect(audit).not.toContain(databaseName);
  });

  it("rejects rows outside the four supported cities before backup or database writes", async () => {
    const fixture = await createFixture(cleanupDirectories);
    await createAsset(fixture, "fifth-city");
    insertLegacyPublication(
      fixture.db,
      "BEIJING",
      "DESKTOP",
      16,
      legacyElements("fifth-city", "unsupported"),
    );
    fixture.db.close();
    const before = sha256(readFileSync(fixture.databasePath));
    const filesBefore = readdirSync(fixture.directory).sort();

    await expect(runPortalSceneMigration({
      databasePath: fixture.databasePath,
      privateRoot: fixture.privateRoot,
      dryRun: false,
    })).rejects.toThrow(/unsupported.*city|city.*unsupported|four.*cit/i);

    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(readdirSync(fixture.directory).sort()).toEqual(filesBefore);
  });
});

async function createFixture(
  cleanupDirectories: string[],
  databaseName = "portal.db",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-portal-migration-"));
  cleanupDirectories.push(directory);
  const privateRoot = path.join(directory, "private");
  const databasePath = path.join(directory, databaseName);
  await mkdir(path.join(privateRoot, "portal"), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  const migrationsRoot = path.resolve("prisma/migrations");
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    db.exec(readFileSync(path.join(migrationsRoot, migration, "migration.sql"), "utf8"));
  }
  db.exec(`
    CREATE TABLE "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" DATETIME,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )
  `);
  const insertLedger = db.prepare(`
    INSERT INTO "_prisma_migrations" (
      "id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count"
    ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, 1)
  `);
  for (const migration of migrations) {
    const bytes = readFileSync(path.join(migrationsRoot, migration, "migration.sql"));
    insertLedger.run(
      `fixture-${migration}`,
      createHash("sha256").update(bytes).digest("hex"),
      migration,
    );
  }
  return { directory, privateRoot, databasePath, db };
}

async function createAsset(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  options: { writeBytes?: boolean } = {},
) {
  const bytes = validPng();
  const storageKey = `portal/${id}.png`;
  if (options.writeBytes !== false) {
    await writeFile(path.join(fixture.privateRoot, storageKey), bytes);
  }
  fixture.db.prepare(`
    INSERT INTO "FileAsset" (
      "id", "kind", "storageKey", "originalName", "mimeType", "sizeBytes",
      "sha256", "uploadedBySnapshot", "createdAt"
    ) VALUES (?, 'PORTAL_IMAGE', ?, ?, 'image/png', ?, ?, '{}', CURRENT_TIMESTAMP)
  `).run(
    id,
    storageKey,
    `${id}.png`,
    bytes.byteLength,
    sha256(bytes),
  );
}

function legacyElements(
  assetId: string,
  altText: string,
  kind: "LOGO" | "IMAGE" = "IMAGE",
) {
  return [{
    id: `element-${assetId}`,
    kind,
    assetId,
    x: 10,
    y: 20,
    width: 240,
    height: 120,
    zIndex: 0,
    altText,
  }];
}

function insertLegacyPublication(
  db: Database.Database,
  city: string,
  viewport: "DESKTOP" | "MOBILE",
  version: number,
  elements: ReturnType<typeof legacyElements>,
) {
  db.prepare(`
    INSERT INTO "GuidePortalPublication" (
      "id", "city", "viewport", "version", "canvasWidth", "canvasHeight",
      "elements", "publishedBySnapshot", "createdAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP)
  `).run(
    `publication-${city}-${viewport}-${version}`,
    city,
    viewport,
    version,
    viewport === "DESKTOP" ? 1440 : 390,
    viewport === "DESKTOP" ? 900 : 844,
    JSON.stringify(elements),
  );
}

function insertLegacyDraft(
  db: Database.Database,
  city: string,
  viewport: "DESKTOP" | "MOBILE",
  elements: ReturnType<typeof legacyElements>,
) {
  db.prepare(`
    INSERT INTO "GuidePortalDraft" (
      "id", "city", "viewport", "canvasWidth", "canvasHeight", "elements",
      "updatedBySnapshot", "updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP)
  `).run(
    `draft-${city}-${viewport}`,
    city,
    viewport,
    viewport === "DESKTOP" ? 1440 : 390,
    viewport === "DESKTOP" ? 900 : 844,
    JSON.stringify(elements),
  );
}

function insertV1Publication(
  db: Database.Database,
  city: string,
  viewport: "DESKTOP" | "MOBILE",
  version: number,
  assetId: string,
) {
  const scene = {
    ...defaultPortalScene(viewport),
    elements: [{
      id: `element-${assetId}`,
      name: assetId,
      type: "IMAGE",
      assetId,
      altText: assetId,
      fitMode: "CONTAIN",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      cornerRadius: 0,
      action: null,
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      hidden: false,
    }],
  };
  const legacy = legacyElements(assetId, assetId);
  db.prepare(`
    INSERT INTO "GuidePortalPublication" (
      "id", "city", "viewport", "version", "canvasWidth", "canvasHeight",
      "elements", "sceneVersion", "scene", "legacyElements",
      "publishedBySnapshot", "createdAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '{}', CURRENT_TIMESTAMP)
  `).run(
    `publication-${city}-${viewport}-${version}`,
    city,
    viewport,
    version,
    viewport === "DESKTOP" ? 1440 : 390,
    viewport === "DESKTOP" ? 900 : 844,
    JSON.stringify(legacy),
    JSON.stringify(scene),
    JSON.stringify(legacy),
  );
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

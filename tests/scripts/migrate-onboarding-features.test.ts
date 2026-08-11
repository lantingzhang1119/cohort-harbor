import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureDatabaseInvariants,
  type DatabaseInvariantSnapshot,
} from "../../scripts/lib/database-invariants";
import { migrateOnboardingFeatures } from "../../scripts/migrate-onboarding-features";

const onboardingMigration = "202607220001_onboarding_mail_permissions";
const execFileAsync = promisify(execFile);

describe("controlled onboarding database migration", () => {
  let directory: string | undefined;
  let fixtureConnection: Database.Database | undefined;

  afterEach(async () => {
    fixtureConnection?.close();
    fixtureConnection = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("backs up committed WAL rows and applies all pending onboarding migrations without changing employees", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;

    const walPath = `${fixture.databasePath}-wal`;
    expect(statSync(walPath).size).toBeGreaterThan(0);

    const before = await captureDatabaseInvariants(fixture.databasePath);
    expect(before.employeeCount).toBe(319);

    const report = await migrateOnboardingFeatures({
      dbPath: fixture.databasePath,
      backupDir: fixture.backupDir,
    });

    expect(report.appliedMigrations).toEqual([
      "202607220001_onboarding_mail_permissions",
      "202607230001_onboarding_mail_manual_uniqueness",
    ]);
    expect(report.before.employeeCount).toBe(319);
    expect(report.before.employeeIdDigest).toBe(before.employeeIdDigest);
    expect(report.backup.employeeIdDigest).toBe(before.employeeIdDigest);
    expect(report.after.employeeIdDigest).toBe(before.employeeIdDigest);
    expect(report.after.superAdminCount).toBe(1);
    expect(report.after.deliveryCount).toBe(0);
    expect(report.after.automationEnabled).toBe(false);
    expect(report.backupSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.backupSha256).toBe(
      createHash("sha256").update(readFileSync(report.backupPath)).digest("hex"),
    );

    const migrated = new Database(fixture.databasePath, { readonly: true });
    try {
      const index = migrated
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'OnboardingMailDelivery_active_manual_recipient_key'`,
        )
        .get() as { sql: string } | undefined;
      expect(index?.sql).toContain(`WHERE "source" = 'MANUAL'`);
      const ledgerRows = migrated
        .prepare(
          `SELECT "migration_name" AS migrationName, "checksum", "finished_at" AS finishedAt, "rolled_back_at" AS rolledBackAt, "applied_steps_count" AS appliedStepsCount
           FROM "_prisma_migrations"
           WHERE "migration_name" >= ?
           ORDER BY "migration_name"`,
        )
        .all(onboardingMigration) as Array<{
        migrationName: string;
        checksum: string;
        finishedAt: string;
        rolledBackAt: null;
        appliedStepsCount: number;
      }>;
      expect(ledgerRows).toEqual(
        [
          "202607220001_onboarding_mail_permissions",
          "202607230001_onboarding_mail_manual_uniqueness",
        ].map((migrationName) => ({
          migrationName,
          checksum: migrationChecksum(migrationName),
          finishedAt: expect.any(String),
          rolledBackAt: null,
          appliedStepsCount: 1,
        })),
      );
    } finally {
      migrated.close();
    }

    const backupFiles = readdirSync(fixture.backupDir).filter((file) =>
      file.endsWith(".sqlite"),
    );
    expect(backupFiles).toEqual([path.basename(report.backupPath)]);

    const restoredPath = path.join(fixture.directory, "restored.db");
    const backup = new Database(report.backupPath, { readonly: true });
    try {
      await backup.backup(restoredPath);
    } finally {
      backup.close();
    }
    const restored = await captureDatabaseInvariants(restoredPath);
    expect(restored.employeeCount).toBe(319);
    expect(restored.employeeIdDigest).toBe(before.employeeIdDigest);
    expectRepresentativeRelations(report.backupPath);
    expectRepresentativeRelations(fixture.databasePath);
    expectRepresentativeRelations(restoredPath);

    const persistedReport = await readFile(report.reportPath, "utf8");
    expect(persistedReport).not.toContain("Synthetic Employee");
    expect(persistedReport).not.toContain("@example.test");
    expect(persistedReport).not.toContain(fixture.directory);
    expect(JSON.parse(persistedReport)).toMatchObject({
      appliedMigrations: report.appliedMigrations,
      backupSha256: report.backupSha256,
      before: report.before,
      backup: report.backup,
      after: report.after,
    });
    expect(JSON.parse(persistedReport)).not.toHaveProperty("databasePath");
    expect(JSON.parse(persistedReport)).not.toHaveProperty("backupPath");
    expect(JSON.parse(persistedReport)).not.toHaveProperty("reportPath");

    const rerun = await migrateOnboardingFeatures({
      dbPath: fixture.databasePath,
      backupDir: fixture.backupDir,
    });
    expect(rerun.appliedMigrations).toEqual([]);
    expect(rerun.after.automationEnabled).toBe(false);
    const rerunConnection = new Database(fixture.databasePath, { readonly: true });
    try {
      const onboardingLedgerCount = rerunConnection
        .prepare(
          `SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE "migration_name" >= ? AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
        )
        .get(onboardingMigration) as { count: number };
      expect(onboardingLedgerCount.count).toBe(2);
    } finally {
      rerunConnection.close();
    }

    fixture.connection.close();
    fixtureConnection = undefined;
    const deploy = await execFileAsync(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:${fixture.databasePath}`,
        },
        timeout: 30_000,
      },
    );
    const firstDeployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    expect(firstDeployOutput).toContain(
      "Applying migration `202607250001_visual_portal_scene`",
    );
    expect(firstDeployOutput).toContain(
      "Applying migration `202607250002_visual_portal_publication_scene`",
    );

    const confirmDeploy = await execFileAsync(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:${fixture.databasePath}`,
        },
        timeout: 30_000,
      },
    );
    expect(`${confirmDeploy.stdout}\n${confirmDeploy.stderr}`).toMatch(
      /No pending migrations to apply/i,
    );
  }, 45_000);

  it("rolls back a forced migration failure and keeps the validated backup recoverable", async () => {
    const fixture = await createSyntheticDatabase({ forceMigrationFailure: true });
    directory = fixture.directory;
    fixtureConnection = fixture.connection;
    const before = await captureDatabaseInvariants(fixture.databasePath);
    const ledgerBefore = readMigrationLedger(fixture.databasePath);

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/EmployeeModuleSetting|already exists/);

    const afterFailure = await captureDatabaseInvariants(fixture.databasePath);
    expectEmployeeIdentity(afterFailure, before);
    expect(readMigrationLedger(fixture.databasePath)).toEqual(ledgerBefore);

    const source = new Database(fixture.databasePath, { readonly: true });
    try {
      const systemSettingColumns = source
        .prepare(`PRAGMA table_info("SystemSetting")`)
        .all() as Array<{ name: string }>;
      expect(systemSettingColumns.map(({ name }) => name)).not.toContain(
        "onboardingMailAutomationEnabled",
      );
      expect(source.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(source.pragma("foreign_key_check")).toEqual([]);
    } finally {
      source.close();
    }

    const backupFile = readdirSync(fixture.backupDir).find((file) =>
      file.endsWith(".sqlite"),
    );
    expect(backupFile).toBeDefined();
    const backupPath = path.join(fixture.backupDir, backupFile!);
    const backup = await captureDatabaseInvariants(backupPath);
    expectEmployeeIdentity(backup, before);

    const restoredPath = path.join(fixture.directory, "failure-restored.db");
    const backupConnection = new Database(backupPath, { readonly: true });
    try {
      await backupConnection.backup(restoredPath);
    } finally {
      backupConnection.close();
    }
    const restored = await captureDatabaseInvariants(restoredPath);
    expectEmployeeIdentity(restored, before);
    expect(statSync(`${fixture.databasePath}.onboarding-migration.lock`, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("rejects relative paths and an existing maintenance lock", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;

    await expect(
      migrateOnboardingFeatures({
        dbPath: path.relative(process.cwd(), fixture.databasePath),
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/absolute/i);

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: path.relative(process.cwd(), fixture.backupDir),
      }),
    ).rejects.toThrow(/absolute/i);

    const lockPath = `${fixture.databasePath}.onboarding-migration.lock`;
    const lock = new Database(fixture.databasePath);
    lock.close();
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(lockPath, "held", { flag: "wx" }),
    );
    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/maintenance lock/i);
  });

  it("refuses a rerun when onboarding mail automation is already enabled", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;
    await migrateOnboardingFeatures({
      dbPath: fixture.databasePath,
      backupDir: fixture.backupDir,
    });
    fixture.connection
      .prepare(
        `UPDATE "SystemSetting" SET "onboardingMailAutomationEnabled" = 1 WHERE "id" = 'default'`,
      )
      .run();
    const artifactsBefore = readdirSync(fixture.backupDir).sort();

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/automation is enabled/i);
    expect(readdirSync(fixture.backupDir).sort()).toEqual(artifactsBefore);
  });

  it("refuses an unfinished Prisma migration ledger row without applying DDL", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;
    fixture.connection
      .prepare(`
        INSERT INTO "_prisma_migrations" (
          "id", "checksum", "migration_name", "started_at", "applied_steps_count"
        ) VALUES ('unfinished-onboarding', ?, ?, CURRENT_TIMESTAMP, 0)
      `)
      .run(migrationChecksum(onboardingMigration), onboardingMigration);
    const ledgerBefore = readMigrationLedger(fixture.databasePath);

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/unfinished|failed|not completed/i);
    expect(readMigrationLedger(fixture.databasePath)).toEqual(ledgerBefore);
    expect(readdirSync(fixture.backupDir)).toEqual([]);

    const source = new Database(fixture.databasePath, { readonly: true });
    try {
      const columns = source.prepare(`PRAGMA table_info("SystemSetting")`).all() as Array<{
        name: string;
      }>;
      expect(columns.map(({ name }) => name)).not.toContain(
        "onboardingMailAutomationEnabled",
      );
    } finally {
      source.close();
    }
  });

  it("rejects a same-name index that does not implement the committed partial unique constraint", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;
    await migrateOnboardingFeatures({
      dbPath: fixture.databasePath,
      backupDir: fixture.backupDir,
    });
    fixture.connection.exec(`
      DROP INDEX "OnboardingMailDelivery_active_manual_recipient_key";
      CREATE INDEX "OnboardingMailDelivery_active_manual_recipient_key"
      ON "OnboardingMailDelivery"("status");
    `);

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/schema\/ledger mismatch/i);
  });

  it("refuses any unresolved unexpected Prisma ledger row before backup", async () => {
    const fixture = await createSyntheticDatabase();
    directory = fixture.directory;
    fixtureConnection = fixture.connection;
    fixture.connection
      .prepare(`
        INSERT INTO "_prisma_migrations" (
          "id", "checksum", "migration_name", "started_at", "applied_steps_count"
        ) VALUES ('unexpected-failure', ?, '209901010000_unexpected', CURRENT_TIMESTAMP, 0)
      `)
      .run("0".repeat(64));

    await expect(
      migrateOnboardingFeatures({
        dbPath: fixture.databasePath,
        backupDir: fixture.backupDir,
      }),
    ).rejects.toThrow(/unexpected|unfinished|failed/i);
    expect(readdirSync(fixture.backupDir)).toEqual([]);
  });
});

function expectEmployeeIdentity(
  actual: DatabaseInvariantSnapshot,
  expected: DatabaseInvariantSnapshot,
) {
  expect(actual.employeeCount).toBe(expected.employeeCount);
  expect(actual.employeeIdDigest).toBe(expected.employeeIdDigest);
  expect(actual.superAdminCount).toBe(1);
  expect(actual.deliveryCount).toBe(0);
}

async function createSyntheticDatabase(options: { forceMigrationFailure?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-controlled-migration-"));
  const databasePath = path.join(directory, "synthetic.db");
  const backupDir = path.join(directory, "backups");
  await mkdir(backupDir);

  let connection = new Database(databasePath);
  connection.pragma("foreign_keys = ON");
  const migrationsRoot = path.resolve("prisma/migrations");
  const priorMigrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name < onboardingMigration,
    )
    .map((entry) => entry.name)
    .sort();
  for (const migration of priorMigrations) {
    const sql = readFileSync(
      path.join(migrationsRoot, migration, "migration.sql"),
      "utf8",
    );
    connection.exec(sql);
  }
  createPrismaMigrationLedger(connection);
  for (const migration of priorMigrations) {
    insertMigrationLedgerRow(connection, migration);
  }

  const insertUser = connection.prepare(`
    INSERT INTO "User" (
      "id", "employeeNo", "name", "email", "role", "status", "enabled",
      "workLocation", "sourceType", "passwordHash", "mustChangePassword",
      "failedLoginCount", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE', 1, 'UNSET', 'MANUAL', 'synthetic-hash', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  const insertUsers = connection.transaction((start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      const suffix = String(index).padStart(3, "0");
      insertUser.run(
        `synthetic-user-${suffix}`,
        `SYN-${suffix}`,
        `Synthetic Employee ${suffix}`,
        `employee-${suffix}@example.test`,
      );
    }
  });

  connection.exec(`
    INSERT INTO "User" (
      "id", "employeeNo", "name", "email", "role", "status", "enabled",
      "workLocation", "sourceType", "passwordHash", "mustChangePassword",
      "failedLoginCount", "createdAt", "updatedAt"
    ) VALUES (
      'synthetic-superadmin', 'ADMIN-001', 'Synthetic Administrator',
      'administrator@example.test', 'SUPER_ADMIN', 'ACTIVE', 1, 'UNSET',
      'MANUAL', 'synthetic-hash', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `);
  insertUsers(0, 318);
  connection.exec(`
    INSERT INTO "Session" ("id", "tokenHash", "userId", "expiresAt")
    VALUES ('representative-session', 'representative-token', 'synthetic-user-001', '2030-01-01T00:00:00Z');
    INSERT INTO "Notification" ("id", "userId", "type", "title", "body", "createdAt")
    VALUES ('representative-notification', 'synthetic-user-002', 'SYSTEM', 'fixture', 'fixture', CURRENT_TIMESTAMP);
    INSERT INTO "SystemSetting" ("id", "watermarkOpacity", "defaultExamMinutes", "defaultDueDays", "showWrongAnswers", "updatedAt")
    VALUES ('default', 0.07, 30, 7, 0, CURRENT_TIMESTAMP);
  `);

  if (options.forceMigrationFailure) {
    connection.exec(`
      CREATE TABLE "EmployeeModuleSetting" (
        "key" TEXT NOT NULL PRIMARY KEY
      );
    `);
  }

  connection.close();
  connection = new Database(databasePath);
  connection.pragma("journal_mode = WAL");
  connection.pragma("wal_autocheckpoint = 0");
  connection
    .prepare(`
      INSERT INTO "User" (
        "id", "employeeNo", "name", "email", "role", "status", "enabled",
        "workLocation", "sourceType", "passwordHash", "mustChangePassword",
        "failedLoginCount", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE', 1, 'UNSET', 'MANUAL', 'synthetic-hash', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    .run(
      "synthetic-user-318",
      "SYN-318",
      "Synthetic Employee 318",
      "employee-318@example.test",
    );

  return { directory, databasePath, backupDir, connection };
}

function createPrismaMigrationLedger(connection: Database.Database) {
  connection.exec(`
    CREATE TABLE "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" DATETIME,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );
  `);
}

function insertMigrationLedgerRow(
  connection: Database.Database,
  migrationName: string,
) {
  connection
    .prepare(`
      INSERT INTO "_prisma_migrations" (
        "id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count"
      ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, 1)
    `)
    .run(`fixture-${migrationName}`, migrationChecksum(migrationName), migrationName);
}

function migrationChecksum(migrationName: string): string {
  const sql = readFileSync(
    path.resolve("prisma/migrations", migrationName, "migration.sql"),
  );
  return createHash("sha256").update(sql).digest("hex");
}

function readMigrationLedger(databasePath: string) {
  const connection = new Database(databasePath, { readonly: true });
  try {
    return connection
      .prepare(
        `SELECT "migration_name" AS migrationName, "checksum" FROM "_prisma_migrations" ORDER BY "migration_name"`,
      )
      .all();
  } finally {
    connection.close();
  }
}

function expectRepresentativeRelations(databasePath: string) {
  const connection = new Database(databasePath, { readonly: true });
  try {
    expect(
      (
        connection
          .prepare(
            `SELECT COUNT(*) AS count FROM "Session" WHERE "id" = 'representative-session' AND "userId" = 'synthetic-user-001'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        connection
          .prepare(
            `SELECT COUNT(*) AS count FROM "Notification" WHERE "id" = 'representative-notification' AND "userId" = 'synthetic-user-002'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  } finally {
    connection.close();
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  captureDatabaseInvariantsFromConnection,
  type DatabaseInvariantSnapshot,
  tableExists,
} from "./lib/database-invariants";

const migrationsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);
const onboardingMigrations = [
  "202607220001_onboarding_mail_permissions",
  "202607230001_onboarding_mail_manual_uniqueness",
] as const;
const prerequisiteMigrations = [
  "20260716104033_init",
  "202607210001_admin_security_portal",
  "202607210002_admin_recipient_history",
  "202607210003_password_reset_hardening",
  "202607210004_portal_asset_references",
] as const;

export interface MigrationReport {
  databasePath: string;
  backupPath: string;
  reportPath: string;
  startedAt: string;
  completedAt: string;
  appliedMigrations: string[];
  backupSha256: string;
  before: DatabaseInvariantSnapshot;
  backup: DatabaseInvariantSnapshot;
  after: DatabaseInvariantSnapshot;
}

export async function migrateOnboardingFeatures(options: {
  dbPath: string;
  backupDir: string;
}): Promise<MigrationReport> {
  const databasePath = validateDatabasePath(options.dbPath);
  const backupDirectory = validateBackupDirectory(options.backupDir);
  const lockPath = `${databasePath}.onboarding-migration.lock`;
  const lock = await acquireMaintenanceLock(lockPath, databasePath);
  const startedAt = new Date().toISOString();

  try {
    const source = new Database(databasePath, { fileMustExist: true });
    try {
      // This must be the first statement executed on the migration connection.
      source.pragma("foreign_keys = ON");
      if (source.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new Error("Could not enable SQLite foreign key enforcement");
      }
      source.pragma("busy_timeout = 5000");

      const before = captureDatabaseInvariantsFromConnection(source);
      assertSafetyInvariants(before, "before backup");
      assertMigrationPrerequisites(source);

      const artifactId = `${formatTimestamp(startedAt)}-${randomUUID().slice(0, 8)}`;
      const backupPath = path.join(
        backupDirectory,
        `${path.basename(databasePath)}.${artifactId}.backup.sqlite`,
      );
      if (existsSync(backupPath)) {
        throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);
      }

      await source.backup(backupPath);
      const backup = validateBackup(backupPath);
      assertSafetyInvariants(backup, "validated backup");
      assertEmployeeIdentityUnchanged(before, backup, "online backup");

      const appliedMigrations: string[] = [];
      let after: DatabaseInvariantSnapshot | undefined;
      source.transaction(() => {
        const immediatelyBeforeMigration =
          captureDatabaseInvariantsFromConnection(source);
        assertSafetyInvariants(immediatelyBeforeMigration, "before migration");
        assertEmployeeIdentityUnchanged(
          backup,
          immediatelyBeforeMigration,
          "maintenance window",
        );

        for (const migration of onboardingMigrations) {
          const schemaApplied = isMigrationSchemaApplied(source, migration);
          const ledgerApplied = isMigrationLedgerApplied(source, migration);
          if (schemaApplied !== ledgerApplied) {
            throw new Error(
              `Prisma migration schema/ledger mismatch for ${migration}`,
            );
          }
          if (schemaApplied) continue;
          const migrationPath = path.join(migrationsRoot, migration, "migration.sql");
          const migrationSql = readFileSync(migrationPath);
          source.exec(migrationSql.toString("utf8"));
          insertMigrationLedgerRow(
            source,
            migration,
            createHash("sha256").update(migrationSql).digest("hex"),
          );
          appliedMigrations.push(migration);
        }

        after = captureDatabaseInvariantsFromConnection(source);
        assertSafetyInvariants(after, "after migration");
        if (after.automationEnabled !== false) {
          throw new Error(
            "Database invariant failed after migration: onboarding mail automation default is not disabled",
          );
        }
        assertEmployeeIdentityUnchanged(before, after, "migration");
        assertOnboardingSchemaComplete(source);
      }).immediate();

      if (!after) throw new Error("Migration transaction did not complete");
      const completedAt = new Date().toISOString();
      const reportPath = path.join(
        backupDirectory,
        `onboarding-migration-${artifactId}.json`,
      );
      const report: MigrationReport = {
        databasePath,
        backupPath,
        reportPath,
        startedAt,
        completedAt,
        appliedMigrations,
        backupSha256: hashFile(backupPath),
        before,
        backup,
        after,
      };
      const persistedEvidence = {
        startedAt,
        completedAt,
        appliedMigrations,
        backupSha256: report.backupSha256,
        before,
        backup,
        after,
      };
      await writeFile(reportPath, `${JSON.stringify(persistedEvidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return report;
    } finally {
      source.close();
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function validateDatabasePath(dbPath: string): string {
  assertAbsolutePath(dbPath, "Database path");
  const details = lstatSync(dbPath);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Database path must name a regular, non-symlink file");
  }
  return realpathSync(dbPath);
}

function validateBackupDirectory(backupDir: string): string {
  assertAbsolutePath(backupDir, "Backup directory");
  const root = path.parse(backupDir).root;
  if (path.normalize(backupDir) === path.normalize(root)) {
    throw new Error("Backup directory must not be a filesystem root");
  }
  const details = lstatSync(backupDir);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Backup directory must be an existing, non-symlink directory");
  }
  return realpathSync(backupDir);
}

async function acquireMaintenanceLock(lockPath: string, databasePath: string) {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, databasePath, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    return handle;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Database maintenance lock already exists: ${lockPath}`);
    }
    throw error;
  }
}

function validateBackup(backupPath: string): DatabaseInvariantSnapshot {
  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    backup.pragma("foreign_keys = ON");
    return captureDatabaseInvariantsFromConnection(backup);
  } finally {
    backup.close();
  }
}

function assertMigrationPrerequisites(connection: Database.Database): void {
  for (const table of [
    "User",
    "SystemSetting",
    "FileAsset",
    "GuidePortalAssetReference",
    "_prisma_migrations",
  ]) {
    if (!tableExists(connection, table)) {
      throw new Error(`Migration prerequisite is missing table ${table}`);
    }
  }
  assertEntireMigrationLedgerIsClean(connection);
  for (const migration of prerequisiteMigrations) {
    if (!isMigrationLedgerApplied(connection, migration)) {
      throw new Error(
        `Migration prerequisite is missing a completed Prisma ledger row: ${migration}`,
      );
    }
  }
  for (const migration of onboardingMigrations) {
    const schemaApplied = isMigrationSchemaApplied(connection, migration);
    const ledgerApplied = isMigrationLedgerApplied(connection, migration);
    if (schemaApplied !== ledgerApplied) {
      throw new Error(`Prisma migration schema/ledger mismatch for ${migration}`);
    }
  }
}

function assertEntireMigrationLedgerIsClean(
  connection: Database.Database,
): void {
  const knownMigrations = new Set<string>([
    ...prerequisiteMigrations,
    ...onboardingMigrations,
  ]);
  const rows = connection
    .prepare(
      `SELECT
         "migration_name" AS migrationName,
         "finished_at" AS finishedAt,
         "rolled_back_at" AS rolledBackAt
       FROM "_prisma_migrations"`,
    )
    .all() as Array<{
    migrationName: string;
    finishedAt: string | null;
    rolledBackAt: string | null;
  }>;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!knownMigrations.has(row.migrationName)) {
      throw new Error(
        `Prisma migration ledger contains an unexpected migration: ${row.migrationName}`,
      );
    }
    if (seen.has(row.migrationName)) {
      throw new Error(
        `Prisma migration ledger has duplicate rows for ${row.migrationName}`,
      );
    }
    seen.add(row.migrationName);
    if (row.finishedAt === null || row.rolledBackAt !== null) {
      throw new Error(
        `Prisma migration ledger contains an unfinished or failed row for ${row.migrationName}`,
      );
    }
  }
}

function assertSafetyInvariants(
  snapshot: DatabaseInvariantSnapshot,
  phase: string,
): void {
  if (snapshot.superAdminCount !== 1) {
    throw new Error(
      `Database invariant failed ${phase}: expected exactly one SUPER_ADMIN, found ${snapshot.superAdminCount}`,
    );
  }
  if (snapshot.deliveryCount !== 0) {
    throw new Error(
      `Database invariant failed ${phase}: expected zero onboarding mail deliveries, found ${snapshot.deliveryCount}`,
    );
  }
  if (snapshot.automationEnabled === true) {
    throw new Error(
      `Database invariant failed ${phase}: onboarding mail automation is enabled`,
    );
  }
  if (snapshot.integrityCheck !== "ok" || snapshot.foreignKeyViolationCount !== 0) {
    throw new Error(`Database invariant failed ${phase}: SQLite checks did not pass`);
  }
}

function assertEmployeeIdentityUnchanged(
  before: DatabaseInvariantSnapshot,
  after: DatabaseInvariantSnapshot,
  phase: string,
): void {
  if (
    before.employeeCount !== after.employeeCount ||
    before.employeeIdDigest !== after.employeeIdDigest
  ) {
    throw new Error(`Employee count or ordered ID digest changed during ${phase}`);
  }
}

function isMigrationSchemaApplied(
  connection: Database.Database,
  migration: (typeof onboardingMigrations)[number],
): boolean {
  if (migration === "202607220001_onboarding_mail_permissions") {
    const systemSettingColumns = new Set(
      (
        connection.prepare(`PRAGMA table_info("SystemSetting")`).all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    return (
      systemSettingColumns.has("onboardingMailAutomationEnabled") &&
      systemSettingColumns.has("onboardingMailAutomationEnabledAt") &&
      systemSettingColumns.has("onboardingMailAutomationEnabledById") &&
      tableExists(connection, "EmployeeModuleSetting") &&
      tableExists(connection, "OnboardingMaterial") &&
      tableExists(connection, "OnboardingMailDelivery")
    );
  }
  const indexName = "OnboardingMailDelivery_active_manual_recipient_key";
  const indexEntry = (
    connection.pragma(`index_list("OnboardingMailDelivery")`) as Array<{
      name: string;
      unique: number;
      partial: number;
    }>
  ).find(({ name }) => name === indexName);
  if (indexEntry?.unique !== 1 || indexEntry.partial !== 1) return false;
  const indexColumns = connection.pragma(`index_info("${indexName}")`) as Array<{
    name: string;
  }>;
  if (
    indexColumns.length !== 1 ||
    indexColumns[0]?.name !== "recipientId"
  ) {
    return false;
  }
  const indexDefinition = connection
    .prepare(`SELECT "sql" FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(indexName) as { sql: string } | undefined;
  const normalizedSql = indexDefinition?.sql.replace(/\s+/g, " ").trim() ?? "";
  return (
    normalizedSql.startsWith(`CREATE UNIQUE INDEX "${indexName}"`) &&
    normalizedSql.includes(`ON "OnboardingMailDelivery"("recipientId")`) &&
    normalizedSql.includes(
      `WHERE "source" = 'MANUAL' AND "status" <> 'CANCELLED' AND "recipientId" IS NOT NULL`,
    )
  );
}

function assertOnboardingSchemaComplete(connection: Database.Database): void {
  for (const migration of onboardingMigrations) {
    if (
      !isMigrationSchemaApplied(connection, migration) ||
      !isMigrationLedgerApplied(connection, migration)
    ) {
      throw new Error(`Committed migration did not produce its expected schema: ${migration}`);
    }
  }
}

function isMigrationLedgerApplied(
  connection: Database.Database,
  migrationName: string,
): boolean {
  const rows = connection
    .prepare(
      `SELECT
         "checksum",
         "finished_at" AS finishedAt,
         "rolled_back_at" AS rolledBackAt
       FROM "_prisma_migrations"
       WHERE "migration_name" = ?`,
    )
    .all(migrationName) as Array<{
    checksum: string;
    finishedAt: string | null;
    rolledBackAt: string | null;
  }>;
  if (rows.length > 1) {
    throw new Error(
      `Prisma migration ledger has duplicate rows for ${migrationName}`,
    );
  }
  if (rows.length === 0) return false;
  const row = rows[0]!;
  if (row.finishedAt === null || row.rolledBackAt !== null) {
    throw new Error(
      `Prisma migration ledger contains an unfinished or failed row for ${migrationName}`,
    );
  }
  const expectedChecksum = migrationChecksum(migrationName);
  if (row.checksum !== expectedChecksum) {
    throw new Error(`Prisma migration checksum mismatch for ${migrationName}`);
  }
  return true;
}

function insertMigrationLedgerRow(
  connection: Database.Database,
  migrationName: string,
  checksum: string,
): void {
  connection
    .prepare(
      `INSERT INTO "_prisma_migrations" (
         "id", "checksum", "finished_at", "migration_name", "logs",
         "rolled_back_at", "started_at", "applied_steps_count"
       ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    )
    .run(randomUUID(), checksum, migrationName);
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function migrationChecksum(migrationName: string): string {
  const migrationPath = path.join(
    migrationsRoot,
    migrationName,
    "migration.sql",
  );
  return createHash("sha256")
    .update(readFileSync(migrationPath))
    .digest("hex");
}

function formatTimestamp(value: string): string {
  return value.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an explicit absolute path`);
  }
}

function parseCliArguments(argv: string[]): { dbPath: string; backupDir: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !["--db", "--backup-dir"].includes(key)) {
      throw new Error(
        "Usage: pnpm db:migrate:onboarding -- --db /absolute/database.db --backup-dir /absolute/backup-directory",
      );
    }
    values.set(key, value);
  }
  const dbPath = values.get("--db");
  const backupDir = values.get("--backup-dir");
  if (!dbPath || !backupDir) {
    throw new Error(
      "Both --db and --backup-dir are required and must be explicit absolute paths",
    );
  }
  return { dbPath, backupDir };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  migrateOnboardingFeatures(parseCliArguments(process.argv.slice(2)))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

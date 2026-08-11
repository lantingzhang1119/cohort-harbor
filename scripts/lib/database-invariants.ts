import { createHash } from "node:crypto";
import path from "node:path";

import Database from "better-sqlite3";

export interface DatabaseInvariantSnapshot {
  employeeCount: number;
  employeeIdDigest: string;
  superAdminCount: number;
  deliveryCount: number;
  automationEnabled: boolean | null;
  integrityCheck: "ok";
  foreignKeyViolationCount: number;
}

type CountRow = { count: number };
type IdRow = { id: string };

export async function captureDatabaseInvariants(
  dbPath: string,
): Promise<DatabaseInvariantSnapshot> {
  assertAbsolutePath(dbPath, "Database path");
  const connection = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    connection.pragma("foreign_keys = ON");
    return captureDatabaseInvariantsFromConnection(connection);
  } finally {
    connection.close();
  }
}

export function captureDatabaseInvariantsFromConnection(
  connection: Database.Database,
): DatabaseInvariantSnapshot {
  if (!tableExists(connection, "User")) {
    throw new Error("Database invariant failed: User table is missing");
  }

  const integrityRows = connection.pragma("integrity_check") as Array<
    Record<string, unknown>
  >;
  const integrityMessages = integrityRows.flatMap((row) =>
    Object.values(row).map(String),
  );
  if (integrityMessages.length !== 1 || integrityMessages[0] !== "ok") {
    throw new Error(
      `Database invariant failed: integrity_check returned ${integrityMessages.length} issue(s)`,
    );
  }

  const foreignKeyViolations = connection.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `Database invariant failed: foreign_key_check returned ${foreignKeyViolations.length} violation(s)`,
    );
  }

  const employeeIdHash = createHash("sha256");
  let employeeCount = 0;
  for (const { id } of connection
    .prepare(
      `SELECT "id" FROM "User" WHERE "role" = 'EMPLOYEE' ORDER BY "id" COLLATE BINARY`,
    )
    .iterate() as IterableIterator<IdRow>) {
    employeeIdHash.update(`${Buffer.byteLength(id, "utf8")}:`);
    employeeIdHash.update(id, "utf8");
    employeeIdHash.update("\n");
    employeeCount += 1;
  }

  const superAdminCount = getCount(
    connection,
    `SELECT COUNT(*) AS count FROM "User" WHERE "role" = 'SUPER_ADMIN'`,
  );
  const deliveryCount = tableExists(connection, "OnboardingMailDelivery")
    ? getCount(
        connection,
        `SELECT COUNT(*) AS count FROM "OnboardingMailDelivery"`,
      )
    : 0;
  const systemSettingColumns = tableExists(connection, "SystemSetting")
    ? new Set(
        (
          connection.prepare(`PRAGMA table_info("SystemSetting")`).all() as Array<{
            name: string;
          }>
        ).map(({ name }) => name),
      )
    : new Set<string>();
  const automationEnabled = systemSettingColumns.has(
    "onboardingMailAutomationEnabled",
  )
    ? getCount(
        connection,
        `SELECT COUNT(*) AS count FROM "SystemSetting" WHERE "onboardingMailAutomationEnabled" <> 0`,
      ) > 0
    : null;

  return {
    employeeCount,
    employeeIdDigest: employeeIdHash.digest("hex"),
    superAdminCount,
    deliveryCount,
    automationEnabled,
    integrityCheck: "ok",
    foreignKeyViolationCount: 0,
  };
}

export function tableExists(
  connection: Database.Database,
  tableName: string,
): boolean {
  return Boolean(
    connection
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .get(tableName),
  );
}

function getCount(connection: Database.Database, sql: string): number {
  return (connection.prepare(sql).get() as CountRow).count;
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an explicit absolute path`);
  }
}

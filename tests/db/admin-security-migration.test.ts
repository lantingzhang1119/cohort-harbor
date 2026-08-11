import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const initialMigration = path.resolve(
  "prisma/migrations/20260716104033_init/migration.sql",
);
const adminSecurityMigration = path.resolve(
  "prisma/migrations/202607210001_admin_security_portal/migration.sql",
);

describe("administrator security migration", () => {
  it("preserves historical roles and promotes one deterministic eligible administrator", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(readFileSync(initialMigration, "utf8"));
      sqlite.exec(`
        INSERT INTO "User" (
          "id", "employeeNo", "name", "email", "role", "status", "enabled",
          "sourceType", "passwordHash", "createdAt", "updatedAt"
        ) VALUES
          ('admin-a', 'ADMIN-001', '管理员甲', 'admin-a@example.test', 'ADMIN', 'ACTIVE', true, 'MANUAL', 'hash', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'),
          ('admin-b', 'ADMIN-002', '管理员乙', 'admin-b@example.test', 'ADMIN', 'ACTIVE', true, 'MANUAL', 'hash', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('admin-disabled', 'ADMIN-003', '停用管理员', NULL, 'ADMIN', 'DISABLED', false, 'MANUAL', 'hash', '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z'),
          ('employee-a', 'EMP-001', '员工甲', NULL, 'EMPLOYEE', 'ACTIVE', true, 'MANUAL', 'hash', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z');

        INSERT INTO "Session" ("id", "tokenHash", "userId", "expiresAt")
        VALUES
          ('session-admin-a', 'token-admin-a', 'admin-a', '2030-01-01T00:00:00Z'),
          ('session-admin-b', 'token-admin-b', 'admin-b', '2030-01-01T00:00:00Z'),
          ('session-employee-a', 'token-employee-a', 'employee-a', '2030-01-01T00:00:00Z');

        INSERT INTO "AuditLog" ("id", "actorId", "action", "result")
        VALUES ('audit-a', 'admin-a', 'HISTORICAL_ACTION', 'SUCCESS');

        INSERT INTO "RosterImportBatch" (
          "id", "sourceName", "originalFileName", "fileHash", "actorId"
        ) VALUES ('batch-a', 'fixture', 'fixture.xlsx', 'fixture-hash', 'admin-a');
      `);

      sqlite.exec(readFileSync(adminSecurityMigration, "utf8"));

      expect(
        sqlite.prepare('SELECT "id", "role" FROM "User" ORDER BY "id"').all(),
      ).toEqual([
        { id: "admin-a", role: "SUPER_ADMIN" },
        { id: "admin-b", role: "ADMIN" },
        { id: "admin-disabled", role: "ADMIN" },
        { id: "employee-a", role: "EMPLOYEE" },
      ]);

      const audit = sqlite
        .prepare('SELECT "actorSnapshot" FROM "AuditLog" WHERE "id" = ?')
        .get("audit-a") as { actorSnapshot: string };
      const batch = sqlite
        .prepare('SELECT "actorSnapshot" FROM "RosterImportBatch" WHERE "id" = ?')
        .get("batch-a") as { actorSnapshot: string };
      expect(JSON.parse(audit.actorSnapshot)).toMatchObject({
        id: "admin-a",
        role: "ADMIN",
      });
      expect(JSON.parse(audit.actorSnapshot)).not.toHaveProperty("email");
      expect(JSON.parse(batch.actorSnapshot)).toMatchObject({
        id: "admin-a",
        role: "ADMIN",
      });

      expect(
        sqlite.prepare('SELECT "id", "viewMode" FROM "Session" ORDER BY "id"').all(),
      ).toEqual([
        { id: "session-admin-a", viewMode: "ADMIN" },
        { id: "session-admin-b", viewMode: "ADMIN" },
        { id: "session-employee-a", viewMode: "EMPLOYEE" },
      ]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

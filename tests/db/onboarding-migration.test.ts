import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const migrationName = "202607220001_onboarding_mail_permissions";

describe("onboarding additive migration", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves 319 employee identities and adds safe disabled automation defaults", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-onboarding-migration-"));
    const databasePath = path.join(directory, "migration.db");
    const sqlite = new Database(databasePath);
    const migrationsRoot = path.resolve("prisma/migrations");
    const prior = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort();
    for (const name of prior) {
      sqlite.exec(readFileSync(path.join(migrationsRoot, name, "migration.sql"), "utf8"));
    }

    const insertUser = sqlite.prepare(`
      INSERT INTO "User" (
        "id", "employeeNo", "name", "role", "status", "enabled", "workLocation",
        "sourceType", "passwordHash", "mustChangePassword", "failedLoginCount",
        "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, 'UNSET', 'MANUAL', 'synthetic-hash', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    sqlite.transaction(() => {
      for (let index = 0; index < 319; index += 1) {
        insertUser.run(
          `synthetic-user-${String(index).padStart(3, "0")}`,
          `SYN-${String(index).padStart(3, "0")}`,
          `测试员工${index}`,
          index === 0 ? "SUPER_ADMIN" : "EMPLOYEE",
        );
      }
      sqlite.prepare(`INSERT INTO "SystemSetting" ("id", "watermarkOpacity", "defaultExamMinutes", "defaultDueDays", "showWrongAnswers", "updatedAt") VALUES ('default', 0.07, 30, 7, 0, CURRENT_TIMESTAMP)`).run();
    })();
    const beforeIds = sqlite.prepare(`SELECT "id" FROM "User" ORDER BY "id"`).all() as Array<{ id: string }>;
    const beforeDigest = createHash("sha256").update(beforeIds.map(({ id }) => id).join("\n")).digest("hex");
    sqlite.close();

    const migrationSql = await readFile(path.join(migrationsRoot, migrationName, "migration.sql"), "utf8");
    const migrated = new Database(databasePath);
    migrated.pragma("foreign_keys = ON");
    migrated.exec(migrationSql);

    const afterIds = migrated.prepare(`SELECT "id" FROM "User" ORDER BY "id"`).all() as Array<{ id: string }>;
    const afterDigest = createHash("sha256").update(afterIds.map(({ id }) => id).join("\n")).digest("hex");
    expect(afterIds).toHaveLength(319);
    expect(afterDigest).toBe(beforeDigest);
    expect((migrated.prepare(`SELECT COUNT(*) AS count FROM "User" WHERE "role" = 'SUPER_ADMIN'`).get() as { count: number }).count).toBe(1);
    expect(migrated.prepare(`SELECT "key", "enabled" FROM "EmployeeModuleSetting" ORDER BY "key"`).all()).toHaveLength(7);
    expect((migrated.prepare(`SELECT "onboardingMailAutomationEnabled" AS enabled, "onboardingMailAutomationEnabledAt" AS enabledAt FROM "SystemSetting" WHERE "id" = 'default'`).get() as { enabled: number; enabledAt: null })).toEqual({ enabled: 0, enabledAt: null });
    expect((migrated.prepare(`SELECT COUNT(*) AS count FROM "OnboardingMailDelivery"`).get() as { count: number }).count).toBe(0);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });
});

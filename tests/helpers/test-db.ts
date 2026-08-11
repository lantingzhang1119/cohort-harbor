import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { createPrismaClient } from "@/lib/db/create-client";

export async function createTestDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-test-"));
  const databasePath = path.join(directory, "test.db");
  const migrationsPath = path.resolve("prisma/migrations");
  const sqlite = new Database(databasePath);
  for (const migration of readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrationsPath, migration, "migration.sql"), "utf8"));
  }
  sqlite.close();

  const db = createPrismaClient(`file:${databasePath.replaceAll("\\", "/")}`);
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;

  return {
    db,
    databasePath,
    databaseUrl,
    async cleanup() {
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

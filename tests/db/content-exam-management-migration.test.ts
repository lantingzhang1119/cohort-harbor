import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationName = "202607280001_content_exam_management";
const migrationsRoot = join(process.cwd(), "prisma", "migrations");

function migrationNames(before?: string) {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!before || entry.name < before))
    .map((entry) => entry.name)
    .sort();
}

function applyMigrations(sqlite: Database.Database, names: string[]) {
  for (const name of names) {
    sqlite.exec(readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"));
  }
}

function columns(sqlite: Database.Database, table: string) {
  return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

describe("content and exam management migration", () => {
  it("adds preview, recycle-bin, question-bank, task-snapshot and notification storage", () => {
    const sqlite = new Database(":memory:");
    try {
      applyMigrations(sqlite, migrationNames());

      expect(columns(sqlite, "Policy")).toEqual(expect.arrayContaining([
        "deletedAt", "deletedById", "statusBeforeDelete",
      ]));
      expect(columns(sqlite, "PolicyVersion")).toEqual(expect.arrayContaining([
        "previewStatus", "previewAssetId", "previewFormat", "previewMetadata", "previewError", "deletedAt",
      ]));
      expect(columns(sqlite, "OnboardingMaterial")).toContain("deletedAt");
      expect(columns(sqlite, "OnboardingMaterialVersion")).toContain("deletedAt");

      const tables = new Set(
        (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      for (const table of [
        "QuestionBank",
        "QuestionBankQuestion",
        "QuestionBankOption",
        "QuestionBankBlankAnswer",
        "QuestionBankImportJob",
        "ExamPaperSnapshot",
        "ExamTask",
        "ExamTaskAssignment",
        "ExamTaskAttempt",
        "ExamTaskAnswer",
      ]) expect(tables.has(table), `missing ${table}`).toBe(true);

      const defaultIndex = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'QuestionBank_one_default_key'")
        .get() as { sql: string } | undefined;
      expect(defaultIndex?.sql).toMatch(/UNIQUE[\s\S]*WHERE[\s\S]*isDefault/i);
      expect(columns(sqlite, "Notification")).toEqual(expect.arrayContaining([
        "examTaskAssignmentId", "dedupeKey", "href",
      ]));
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("converts the legacy exam into one default question bank without changing legacy records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohort-harbor-content-exam-migration-"));
    const databasePath = join(directory, "legacy.db");
    const sqlite = new Database(databasePath);
    try {
      applyMigrations(sqlite, migrationNames(migrationName));
      sqlite.pragma("foreign_keys = ON");

      sqlite.prepare(`INSERT INTO "Exam" ("id", "name", "passingScore", "durationMinutes", "dueDaysAfterHire", "randomizeQuestions", "randomizeOptions", "showWrongAnswers", "enabled", "createdAt", "updatedAt") VALUES ('legacy-exam', '入职学习考试', 80, 30, 7, 1, 1, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
      sqlite.prepare(`INSERT INTO "Question" ("id", "examId", "sequence", "type", "prompt", "score", "enabled", "createdAt", "updatedAt") VALUES ('legacy-question', 'legacy-exam', 1, 'SINGLE', '迁移题目', 100, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
      sqlite.prepare(`INSERT INTO "QuestionOption" ("id", "questionId", "optionKey", "text", "isCorrect", "sortOrder") VALUES ('legacy-option-a', 'legacy-question', 'A', '正确项', 1, 0), ('legacy-option-b', 'legacy-question', 'B', '错误项', 0, 1)`).run();

      sqlite.exec(readFileSync(join(migrationsRoot, migrationName, "migration.sql"), "utf8"));

      expect(sqlite.prepare(`SELECT "name", "isDefault", "status", "source", "legacyExamId", "questionCount", "enabledScore" FROM "QuestionBank"`).get()).toEqual({
        name: "入职学习考试",
        isDefault: 1,
        status: "ENABLED",
        source: "LEGACY",
        legacyExamId: "legacy-exam",
        questionCount: 1,
        enabledScore: 100,
      });
      expect(sqlite.prepare(`SELECT "type", "prompt", "score" FROM "QuestionBankQuestion"`).get()).toEqual({
        type: "SINGLE_CHOICE",
        prompt: "迁移题目",
        score: 100,
      });
      expect(sqlite.prepare(`SELECT "label", "text", "isCorrect" FROM "QuestionBankOption" ORDER BY "sortOrder"`).all()).toEqual([
        { label: "A", text: "正确项", isCorrect: 1 },
        { label: "B", text: "错误项", isCorrect: 0 },
      ]);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Exam"`).get()).toEqual({ count: 1 });
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "Question"`).get()).toEqual({ count: 1 });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

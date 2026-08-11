import "dotenv/config";

import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@/generated/prisma/client";
import { runExamTaskMaintenance } from "@/features/exam-task-runtime/maintenance-service";
import { createPrismaClient } from "@/lib/db/create-client";

type ExamTaskMaintenanceCliDependencies = {
  db: PrismaClient;
  now?: () => Date;
  stdout?: (line: string) => void;
};

export async function runExamTaskMaintenanceCli(
  dependencies: ExamTaskMaintenanceCliDependencies,
) {
  const summary = await runExamTaskMaintenance(
    dependencies.db,
    dependencies.now?.() ?? new Date(),
  );
  (dependencies.stdout ?? console.log)(JSON.stringify(summary));
  return summary;
}

export async function runExamTaskMaintenanceMain(
  dependencies: {
    env?: Partial<NodeJS.ProcessEnv>;
    createDb?: (databaseUrl?: string) => PrismaClient;
    now?: () => Date;
    stdout?: (line: string) => void;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("考试维护必须显式配置 DATABASE_URL");
  if (!databaseUrl.startsWith("file:") || !path.isAbsolute(databaseUrl.slice("file:".length))) {
    throw new Error("考试维护 DATABASE_URL 必须使用绝对 SQLite 文件路径");
  }
  const db = (dependencies.createDb ?? createPrismaClient)(databaseUrl);
  try {
    return await runExamTaskMaintenanceCli({
      db,
      now: dependencies.now,
      stdout: dependencies.stdout,
    });
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  if (process.argv.length > 2) throw new TypeError("考试维护命令不接受参数");
  await runExamTaskMaintenanceMain();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "考试任务维护失败");
    process.exitCode = 1;
  });
}

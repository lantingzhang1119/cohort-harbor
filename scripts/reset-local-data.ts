import "dotenv/config";

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { databasePathFromUrl } from "../src/lib/db/ensure-database";

export type ResetOptions = {
  projectRoot: string;
  databaseUrl: string;
  confirmed: boolean;
};

function assertInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("重置目标必须位于项目目录内部，且不能是项目根目录");
  }
}

export async function resetLocalData(options: ResetOptions) {
  if (!options.confirmed) {
    throw new Error("拒绝重置：请显式传入 --confirm-local-demo");
  }
  const projectRoot = path.resolve(options.projectRoot);
  const databasePath = path.resolve(databasePathFromUrl(options.databaseUrl, projectRoot));
  const assetsPath = path.resolve(projectRoot, "storage", "private", "assets");
  assertInside(projectRoot, databasePath);
  assertInside(projectRoot, assetsPath);

  for (const target of [databasePath, `${databasePath}-journal`, `${databasePath}-shm`, `${databasePath}-wal`]) {
    assertInside(projectRoot, path.resolve(target));
    await rm(target, { force: true });
  }
  await rm(assetsPath, { recursive: true, force: true });
  return { databasePath, assetsPath };
}

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  resetLocalData({
    projectRoot: process.cwd(),
    databaseUrl: process.env.DATABASE_URL ?? "file:./storage/private/demo.db",
    confirmed: process.argv.includes("--confirm-local-demo"),
  })
    .then(() => console.log("本地 Demo 数据库和生成资产已安全重置。请重新运行启动脚本完成初始化。"))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : "重置失败"); process.exitCode = 1; });
}

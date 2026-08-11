import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import Database from "better-sqlite3";

export function databasePathFromUrl(databaseUrl: string, cwd = process.cwd()): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("本地 Demo 只支持 file: SQLite 地址");
  }

  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath) {
    throw new Error("SQLite 文件地址不能为空");
  }

  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

export async function ensureDatabaseFile(
  databaseUrl: string,
  cwd = process.cwd(),
): Promise<string> {
  const databasePath = databasePathFromUrl(databaseUrl, cwd);
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.close();
  return databasePath;
}

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "@/generated/prisma/client";

const defaultDatabaseUrl = "file:./storage/private/demo.db";
const defaultBusyTimeoutMs = 5_000;

type SqliteClientOptions = {
  busyTimeoutMs?: number;
};

function resolveBusyTimeout(value: number | undefined): number {
  const timeout = value ?? Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? defaultBusyTimeoutMs);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new Error("SQLITE_BUSY_TIMEOUT_MS 必须是 100–60000 之间的整数");
  }
  return timeout;
}

export function createPrismaClient(
  databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl,
  options: SqliteClientOptions = {},
): PrismaClient {
  const busyTimeoutMs = resolveBusyTimeout(options.busyTimeoutMs);
  const baseAdapter = new PrismaBetterSqlite3({ url: databaseUrl, timeout: busyTimeoutMs });
  const configure = async (connect: () => ReturnType<typeof baseAdapter.connect>) => {
    const connection = await connect();
    await connection.executeScript(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${busyTimeoutMs};
      PRAGMA foreign_keys = ON;
    `);
    return connection;
  };
  const adapter = {
    provider: "sqlite" as const,
    adapterName: baseAdapter.adapterName,
    connect: () => configure(() => baseAdapter.connect()),
    connectToShadowDb: () => configure(() => baseAdapter.connectToShadowDb()),
  };
  return new PrismaClient({ adapter });
}

import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/lib/db/create-client";

const childScript = `
const Database = require("better-sqlite3");
const [databasePath, holdMs, timeoutMs] = process.argv.slice(1).map((value, index) => index === 0 ? value : Number(value));
const db = new Database(databasePath, { timeout: timeoutMs });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = " + timeoutMs);
try {
  db.exec("BEGIN IMMEDIATE");
  process.stdout.write("LOCKED\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  db.prepare("INSERT INTO contention(value) VALUES (?)").run(String(holdMs));
  db.exec("COMMIT");
  process.stdout.write("COMMITTED\\n");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  process.stderr.write(String(error && error.code || error) + "\\n");
  process.exitCode = 2;
} finally { db.close(); }
`;

function child(databasePath: string, holdMs: number, timeoutMs: number) {
  return spawn(process.execPath, ["-e", childScript, databasePath, String(holdMs), String(timeoutMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForLocked(process: ReturnType<typeof child>) {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("LOCKED")) {
        process.stdout.off("data", onData);
        process.off("exit", onExit);
        resolve();
      }
    };
    const onExit = () => {
      process.stdout.off("data", onData);
      reject(new Error("writer exited before acquiring lock"));
    };
    process.stdout.on("data", onData);
    process.once("exit", onExit);
  });
}

describe("SQLite runtime concurrency", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("configures WAL and busy_timeout on Prisma connections", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-sqlite-runtime-"));
    const databasePath = path.join(directory, "runtime.db");
    new Database(databasePath).close();
    const db = createPrismaClient(`file:${databasePath}`, { busyTimeoutMs: 1_250 });
    const journal = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    const timeout = await db.$queryRawUnsafe<Array<{ timeout: bigint }>>("PRAGMA busy_timeout");
    expect(journal[0]?.journal_mode.toLowerCase()).toBe("wal");
    expect(Number(timeout[0]?.timeout)).toBe(1_250);
    await db.$disconnect();
  });

  it("lets a short competing writer finish within the timeout and fails a long lock in a controlled way", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-sqlite-contention-"));
    const databasePath = path.join(directory, "contention.db");
    const setup = new Database(databasePath);
    setup.exec("CREATE TABLE contention (value TEXT NOT NULL)");
    setup.close();

    const shortHolder = child(databasePath, 250, 1_000);
    await waitForLocked(shortHolder);
    const shortWaiter = child(databasePath, 0, 1_000);
    const [shortCode, shortWaiterCode] = await Promise.all([once(shortHolder, "exit"), once(shortWaiter, "exit")]);
    expect(shortCode[0]).toBe(0);
    expect(shortWaiterCode[0]).toBe(0);

    const longHolder = child(databasePath, 800, 1_000);
    await waitForLocked(longHolder);
    const longWaiter = child(databasePath, 0, 100);
    let errorText = "";
    longWaiter.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    const [longCode, longWaiterCode] = await Promise.all([once(longHolder, "exit"), once(longWaiter, "exit")]);
    expect(longCode[0]).toBe(0);
    expect(longWaiterCode[0]).toBe(2);
    expect(errorText).toContain("SQLITE_BUSY");
  });
});

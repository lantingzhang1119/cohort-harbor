import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDatabaseFile } from "@/lib/db/ensure-database";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ensureDatabaseFile", () => {
  it("creates the parent directory and an openable SQLite file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cohort-harbor-db-"));
    cleanup.push(root);

    const path = await ensureDatabaseFile("file:./nested/demo.db", root);

    expect(path).toBe(join(root, "nested", "demo.db"));
  });

  it("rejects non-SQLite URLs", async () => {
    await expect(ensureDatabaseFile("postgresql://localhost/demo")).rejects.toThrow(
      "本地 Demo 只支持 file: SQLite 地址",
    );
  });
});

import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetLocalData } from "../../scripts/reset-local-data";

const roots: string[] = [];

async function exists(target: string) {
  try { await access(target); return true; } catch { return false; }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cohort-harbor-reset-"));
  roots.push(root);
  const privateRoot = path.join(root, "storage", "private");
  await mkdir(path.join(privateRoot, "assets", "policies"), { recursive: true });
  await mkdir(path.join(privateRoot, "guide-source-renders"), { recursive: true });
  await writeFile(path.join(privateRoot, "demo.db"), "db");
  await writeFile(path.join(privateRoot, "demo.db-wal"), "wal");
  await writeFile(path.join(privateRoot, "assets", "policies", "upload.pdf"), "pdf");
  await writeFile(path.join(privateRoot, "guide-source-renders", "source.txt"), "preserve source");
  await writeFile(path.join(root, "outside.txt"), "preserve project file");
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safe local reset", () => {
  it("refuses to delete anything without the confirmation flag", async () => {
    const root = await fixture();
    await expect(resetLocalData({ projectRoot: root, databaseUrl: "file:./storage/private/demo.db", confirmed: false })).rejects.toThrow("--confirm-local-demo");
    expect(await exists(path.join(root, "storage", "private", "demo.db"))).toBe(true);
    expect(await exists(path.join(root, "storage", "private", "assets", "policies", "upload.pdf"))).toBe(true);
  });

  it("removes only the resolved database family and generated private assets under the project root", async () => {
    const root = await fixture();
    await resetLocalData({ projectRoot: root, databaseUrl: "file:./storage/private/demo.db", confirmed: true });
    expect(await exists(path.join(root, "storage", "private", "demo.db"))).toBe(false);
    expect(await exists(path.join(root, "storage", "private", "demo.db-wal"))).toBe(false);
    expect(await exists(path.join(root, "storage", "private", "assets"))).toBe(false);
    expect(await exists(path.join(root, "storage", "private", "guide-source-renders", "source.txt"))).toBe(true);
    expect(await exists(path.join(root, "outside.txt"))).toBe(true);
  });

  it("rejects a database path that resolves outside the project root", async () => {
    const root = await fixture();
    await expect(resetLocalData({ projectRoot: root, databaseUrl: "file:../outside.db", confirmed: true })).rejects.toThrow("项目目录");
  });
});

import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupStalePrivateUploads,
  prepareMailValidationTempRoot,
  resolveMailValidationTempRoot,
  stagePrivateUpload,
} from "@/lib/storage/private-upload-validation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function upload(bytes: Uint8Array) {
  return {
    fileName: "safe.txt",
    mimeType: "text/plain",
    size: bytes.byteLength,
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe("private upload validation staging", () => {
  it("resolves mail validation staging strictly below a non-root private storage directory", async () => {
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-private-root-"));
    roots.push(privateRoot);
    expect(resolveMailValidationTempRoot(privateRoot)).toBe(path.join(privateRoot, "tmp/mail-validation"));
    expect(() => resolveMailValidationTempRoot("/", "/tmp/mail-validation")).toThrow("root");
    expect(() => resolveMailValidationTempRoot(privateRoot, path.dirname(privateRoot))).toThrow("private storage");
  });

  it("rejects a symlinked validation root before staging or cleanup can touch its external target", async () => {
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-private-symlink-"));
    const external = await mkdtemp(path.join(tmpdir(), "cohort-harbor-private-external-"));
    roots.push(privateRoot, external);
    await mkdir(path.join(privateRoot, "tmp"));
    await symlink(external, path.join(privateRoot, "tmp/mail-validation"));

    await expect(prepareMailValidationTempRoot(privateRoot)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(cleanupStalePrivateUploads({ privateRoot })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await readdir(external)).toEqual([]);
  });

  it("removes only aged crashed cohort-harbor-upload directories, skips active/new entries and bounds removals", async () => {
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-private-cleanup-"));
    roots.push(privateRoot);
    const tempRoot = resolveMailValidationTempRoot(privateRoot);
    await mkdir(tempRoot, { recursive: true });
    const oldOne = path.join(tempRoot, "cohort-harbor-upload-old001");
    const oldTwo = path.join(tempRoot, "cohort-harbor-upload-old002");
    const fresh = path.join(tempRoot, "cohort-harbor-upload-new001");
    const zipBuild = path.join(tempRoot, "kit-old001");
    const otherProcessActive = path.join(tempRoot, "cohort-harbor-upload-live001");
    for (const directory of [oldOne, oldTwo, fresh, zipBuild, otherProcessActive]) {
      await mkdir(directory);
      await writeFile(path.join(directory, "payload"), "x");
    }
    const now = new Date("2026-07-23T00:00:00.000Z");
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1_000);
    for (const directory of [oldOne, oldTwo, zipBuild, otherProcessActive]) {
      await utimes(path.join(directory, "payload"), old, old);
      await utimes(directory, old, old);
    }
    await writeFile(path.join(otherProcessActive, ".active-pid"), String(process.pid));
    await utimes(path.join(otherProcessActive, ".active-pid"), old, old);
    await utimes(otherProcessActive, old, old);
    const external = await mkdtemp(path.join(tmpdir(), "cohort-harbor-external-"));
    roots.push(external);
    await symlink(external, path.join(tempRoot, "cohort-harbor-upload-link01"));

    const staged = await stagePrivateUpload(upload(Buffer.from("active")), { maxBytes: 100, tempRoot });
    const activeDirectory = path.dirname(staged.stagedPath);
    await utimes(staged.stagedPath, old, old);
    await utimes(activeDirectory, old, old);

    const first = await cleanupStalePrivateUploads({
      privateRoot,
      now: () => now,
      staleAfterMs: 24 * 60 * 60 * 1_000,
      maxEntries: 100,
      maxRemovals: 1,
    });
    expect(first.removed).toBe(1);
    let names = await readdir(tempRoot);
    expect(names.filter((name) => /^cohort-harbor-upload-old/.test(name))).toHaveLength(1);
    expect(names).toContain("cohort-harbor-upload-new001");
    expect(names).toContain("cohort-harbor-upload-link01");
    expect(names).toContain("kit-old001");
    expect(names).toContain("cohort-harbor-upload-live001");
    expect(names).toContain(path.basename(activeDirectory));

    const second = await cleanupStalePrivateUploads({
      privateRoot,
      now: () => now,
      staleAfterMs: 24 * 60 * 60 * 1_000,
      maxEntries: 100,
      maxRemovals: 10,
    });
    expect(second.removed).toBe(1);
    names = await readdir(tempRoot);
    expect(names.some((name) => /^cohort-harbor-upload-old/.test(name))).toBe(false);
    expect(names).toContain("cohort-harbor-upload-live001");
    expect(names).toContain(path.basename(activeDirectory));
    await writeFile(path.join(otherProcessActive, ".active-pid"), "99999999");
    await utimes(path.join(otherProcessActive, ".active-pid"), old, old);
    await utimes(otherProcessActive, old, old);
    const third = await cleanupStalePrivateUploads({
      privateRoot,
      now: () => now,
      staleAfterMs: 24 * 60 * 60 * 1_000,
      maxEntries: 100,
      maxRemovals: 10,
    });
    expect(third.removed).toBe(1);
    expect(await readdir(tempRoot)).not.toContain("cohort-harbor-upload-live001");
    await staged.cleanup();
  });

  it("removes the staging directory when an upload stream cannot be opened", async () => {
    const privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-private-stream-error-"));
    roots.push(privateRoot);
    const tempRoot = resolveMailValidationTempRoot(privateRoot);
    await expect(stagePrivateUpload({
      fileName: "broken.txt",
      mimeType: "text/plain",
      size: 1,
      stream() {
        throw new Error("stream unavailable");
      },
    }, { maxBytes: 10, tempRoot })).rejects.toThrow("stream unavailable");
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

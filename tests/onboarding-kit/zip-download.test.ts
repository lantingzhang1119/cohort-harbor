import { readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { Role, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createMaterial, publishMaterial, replaceMaterialFile } from "@/features/onboarding-kit/material-service";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import * as zipService from "@/features/onboarding-kit/zip-service";
import { OnboardingZipError, buildOnboardingZip } from "@/features/onboarding-kit/zip-service";
import { createTestDatabase } from "../helpers/test-db";

function upload(name: string, text: string, mimeType = "text/plain"): UploadFileLike {
  const bytes = Buffer.from(text);
  return { fileName: name, mimeType, size: bytes.byteLength, stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

function openZip(filePath: string) {
  return new Promise<ZipFile>((resolve, reject) => yauzl.open(filePath, { lazyEntries: true }, (error, zip) => error || !zip ? reject(error) : resolve(zip)));
}

async function zipEntries(filePath: string) {
  const zip = await openZip(filePath);
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.once("error", reject);
    zip.once("end", resolve);
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error); return; }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.once("error", reject);
        stream.once("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return entries;
}

describe("prepared onboarding-kit ZIP", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let zipRoot: string;
  let adminId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-zip-private-"));
    zipRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-zip-build-"));
    const passwordHash = await hashPassword("ZipPass123");
    adminId = (await testDb.db.user.create({ data: { employeeNo: "ZIP-ADMIN", name: "ZIP管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })).id;
  });
  afterEach(async () => { await testDb.cleanup(); await rm(privateRoot, { recursive: true, force: true }); await rm(zipRoot, { recursive: true, force: true }); });

  const serviceOptions = () => ({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });

  it("uses safe category folders, stable duplicate suffixes and current published versions", async () => {
    const first = await createMaterial(adminId, { title: "制度/手册", category: "入职/必读", sortOrder: 1 }, upload("说明.txt", "old"), serviceOptions());
    const second = await createMaterial(adminId, { title: "另一份", category: "入职/必读", sortOrder: 2 }, upload("说明.txt", "second"), serviceOptions());
    await publishMaterial(adminId, first.id, serviceOptions());
    await publishMaterial(adminId, second.id, serviceOptions());
    await replaceMaterialFile(adminId, first.id, upload("说明.txt", "current"), serviceOptions());

    const prepared = await buildOnboardingZip({
      db: testDb.db, privateRoot, zipRoot, materialIds: [second.id, first.id], maxItems: 10, maxTotalBytes: 1024 * 1024,
    });
    const entries = await zipEntries(prepared.path);
    expect([...entries.keys()].sort((left, right) => left.localeCompare(right, "zh-CN"))).toEqual(["入职必读/说明 (2).txt", "入职必读/说明.txt"]);
    expect(entries.get("入职必读/说明.txt")?.toString()).toBe("current");
    expect(entries.get("入职必读/说明 (2).txt")?.toString()).toBe("second");
    expect([...entries.keys()].every((name) => !name.includes("..") && !name.startsWith("/"))).toBe(true);
    expect(prepared.sizeBytes).toBeGreaterThan(0);
    await prepared.cleanup();
    await expect(readFile(prepared.path)).rejects.toThrow();
  });

  it("keeps generated ZIP names unique when an explicit suffix occupies the next duplicate name", async () => {
    const first = await createMaterial(adminId, { title: "第一份", category: "同目录", sortOrder: 1 }, upload("a.pdf", "%PDF-1.7\nfirst\n%%EOF", "application/pdf"), serviceOptions());
    const explicitSecond = await createMaterial(adminId, { title: "第二份", category: "同目录", sortOrder: 2 }, upload("a (2).pdf", "%PDF-1.7\nsecond\n%%EOF", "application/pdf"), serviceOptions());
    const duplicate = await createMaterial(adminId, { title: "第三份", category: "同目录", sortOrder: 3 }, upload("a.pdf", "%PDF-1.7\nthird\n%%EOF", "application/pdf"), serviceOptions());
    await Promise.all([
      publishMaterial(adminId, first.id, serviceOptions()),
      publishMaterial(adminId, explicitSecond.id, serviceOptions()),
      publishMaterial(adminId, duplicate.id, serviceOptions()),
    ]);

    const prepared = await buildOnboardingZip({
      db: testDb.db,
      privateRoot,
      zipRoot,
      materialIds: [first.id, explicitSecond.id, duplicate.id],
      maxItems: 10,
      maxTotalBytes: 1024 * 1024,
    });
    const entries = await zipEntries(prepared.path);

    expect([...entries.keys()].sort()).toEqual([
      "同目录/a (2).pdf",
      "同目录/a (3).pdf",
      "同目录/a.pdf",
    ]);
    expect(entries.get("同目录/a.pdf")?.toString()).toContain("first");
    expect(entries.get("同目录/a (2).pdf")?.toString()).toContain("second");
    expect(entries.get("同目录/a (3).pdf")?.toString()).toContain("third");
    await prepared.cleanup();
  });

  it("rejects stale/draft selections, item and total caps", async () => {
    const draft = await createMaterial(adminId, { title: "草稿", category: "测试", sortOrder: 0 }, upload("draft.txt", "draft"), serviceOptions());
    await expect(buildOnboardingZip({ db: testDb.db, privateRoot, zipRoot, materialIds: [draft.id], maxItems: 10, maxTotalBytes: 100 }))
      .rejects.toMatchObject({ code: "SELECTION_CHANGED" });
    await expect(buildOnboardingZip({ db: testDb.db, privateRoot, zipRoot, materialIds: Array.from({ length: 11 }, (_, index) => String(index)), maxItems: 10, maxTotalBytes: 100 }))
      .rejects.toMatchObject({ code: "TOO_MANY_ITEMS" });
    await publishMaterial(adminId, draft.id, serviceOptions());
    await expect(buildOnboardingZip({ db: testDb.db, privateRoot, zipRoot, materialIds: [draft.id], maxItems: 10, maxTotalBytes: 4 }))
      .rejects.toMatchObject({ code: "TOTAL_TOO_LARGE" });
  });

  it("fails before returning a response when a source disappears and cleans temporary output", async () => {
    const material = await createMaterial(adminId, { title: "丢失", category: "测试", sortOrder: 0 }, upload("lost.txt", "lost"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const version = await testDb.db.onboardingMaterialVersion.findUniqueOrThrow({ where: { id: material.currentVersion!.id }, include: { fileAsset: true } });
    await unlink(path.join(privateRoot, version.fileAsset.storageKey));
    await expect(buildOnboardingZip({ db: testDb.db, privateRoot, zipRoot, materialIds: [material.id], maxItems: 10, maxTotalBytes: 100 }))
      .rejects.toBeInstanceOf(OnboardingZipError);
    expect((await readdir(zipRoot, { recursive: true })).filter((entry) => String(entry).endsWith(".zip"))).toHaveLength(0);
  });

  it("enforces disk-space and concurrent-build reservations", async () => {
    const material = await createMaterial(adminId, { title: "配额", category: "测试", sortOrder: 0 }, upload("quota.txt", "quota"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const base = { db: testDb.db, privateRoot, zipRoot, materialIds: [material.id], maxItems: 10, maxTotalBytes: 100 };
    await expect(buildOnboardingZip({ ...base, availableBytes: 1 })).rejects.toMatchObject({ code: "INSUFFICIENT_DISK_SPACE" });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const first = buildOnboardingZip({ ...base, maxConcurrentBuilds: 1, hooks: { async beforeFinalize() { started.resolve(); await release.promise; } } });
    await started.promise;
    await expect(buildOnboardingZip({ ...base, maxConcurrentBuilds: 1 })).rejects.toMatchObject({ code: "BUILD_BUSY" });
    release.resolve();
    const prepared = await first;
    await prepared.cleanup();
  });

  it.each(["warning", "output-error"] as const)("tears down archive resources when %s wins the build race", async (failureKind) => {
    const material = await createMaterial(adminId, { title: "终止", category: "测试", sortOrder: 0 }, upload("abort.txt", "abort"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const base = { db: testDb.db, privateRoot, zipRoot, materialIds: [material.id], maxItems: 10, maxTotalBytes: 100, availableBytes: 2 * 1024 * 1024 };
    let observed: { archive: { destroyed: boolean; emit(event: string, error: Error): boolean }; output: { closed: boolean; destroyed: boolean; emit(event: string, error: Error): boolean } } | undefined;

    await expect(buildOnboardingZip({
      ...base,
      hooks: {
        async beforeFinalize(resources) {
          observed = resources;
          if (failureKind === "warning") resources.archive.emit("warning", new Error("test warning"));
          else resources.output.emit("error", new Error("test output error"));
        },
      },
    })).rejects.toMatchObject({ code: "ARCHIVE_FAILED" });

    expect(observed?.archive.destroyed).toBe(true);
    expect(observed?.output.destroyed).toBe(true);
    expect(observed?.output.closed).toBe(true);
    expect(() => observed?.archive.emit("error", new Error("late archive error"))).not.toThrow();
    expect((await readdir(zipRoot, { recursive: true })).filter((entry) => String(entry).endsWith(".zip"))).toHaveLength(0);

    const retry = await buildOnboardingZip(base);
    await retry.cleanup();
    await retry.cleanup();
  });

  it("rejects BUILD_BUSY before database, source, stale-cleanup and capacity work", async () => {
    const material = await createMaterial(adminId, { title: "繁忙", category: "测试", sortOrder: 0 }, upload("busy.txt", "busy"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const base = { db: testDb.db, privateRoot, zipRoot, materialIds: [material.id], maxItems: 10, maxTotalBytes: 100, maxConcurrentBuilds: 1 };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = buildOnboardingZip({ ...base, hooks: { async beforeFinalize() { started.resolve(); await release.promise; } } });
    await started.promise;

    const staleDirectory = path.join(zipRoot, "kit-busy-must-not-clean");
    await (await import("node:fs/promises")).mkdir(staleDirectory);
    await writeFile(path.join(staleDirectory, "marker"), "keep");
    const old = new Date(Date.now() - 10_000);
    await utimes(staleDirectory, old, old);
    const findMany = vi.spyOn(testDb.db.onboardingMaterial, "findMany");
    const queryCountBeforeBusyRequest = findMany.mock.calls.length;
    let capacityReads = 0;
    const busyOptions = {
      ...base,
      staleTtlMs: -1,
      get availableBytes() { capacityReads += 1; return 2 * 1024 * 1024; },
    };

    await expect(buildOnboardingZip(busyOptions)).rejects.toMatchObject({ code: "BUILD_BUSY" });
    expect(findMany).toHaveBeenCalledTimes(queryCountBeforeBusyRequest);
    expect(capacityReads).toBe(0);
    await expect(readdir(staleDirectory)).resolves.toContain("marker");

    release.resolve();
    const prepared = await first;
    await prepared.cleanup();
  });

  it("reserves combined per-root capacity until idempotent prepared cleanup", async () => {
    const material = await createMaterial(adminId, { title: "预留", category: "测试", sortOrder: 0 }, upload("reserve.txt", "reserve"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const base = {
      db: testDb.db,
      privateRoot,
      zipRoot,
      materialIds: [material.id],
      maxItems: 10,
      maxTotalBytes: 100,
      maxConcurrentBuilds: 2,
      availableBytes: Math.floor(1.5 * 1024 * 1024),
    };

    const first = await buildOnboardingZip(base);
    await expect(buildOnboardingZip(base)).rejects.toMatchObject({ code: "INSUFFICIENT_DISK_SPACE" });
    await first.cleanup();
    await first.cleanup();

    const afterRelease = await buildOnboardingZip(base);
    await afterRelease.cleanup();
  });

  it("never removes a live build during concurrent stale cleanup", async () => {
    const material = await createMaterial(adminId, { title: "活跃目录", category: "测试", sortOrder: 0 }, upload("live.txt", "live"), serviceOptions());
    await publishMaterial(adminId, material.id, serviceOptions());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const building = buildOnboardingZip({
      db: testDb.db,
      privateRoot,
      zipRoot,
      materialIds: [material.id],
      maxItems: 10,
      maxTotalBytes: 100,
      staleTtlMs: 0,
      hooks: { async beforeFinalize() { started.resolve(); await release.promise; } },
    });
    await started.promise;

    await zipService.cleanStaleOnboardingArchives(zipRoot, -1);
    release.resolve();
    const prepared = await building;
    await expect(readFile(prepared.path)).resolves.not.toHaveLength(0);
    await prepared.cleanup();
  });

  it("removes TTL-expired prepared archives during controlled server startup", async () => {
    const staleDirectory = path.join(zipRoot, "kit-stale");
    const freshDirectory = path.join(zipRoot, "kit-fresh");
    await (await import("node:fs/promises")).mkdir(staleDirectory);
    await (await import("node:fs/promises")).mkdir(freshDirectory);
    await writeFile(path.join(staleDirectory, "onboarding-kit.zip"), "stale");
    await writeFile(path.join(freshDirectory, "onboarding-kit.zip"), "fresh");
    const old = new Date(Date.now() - 2_000);
    await utimes(staleDirectory, old, old);

    await (zipService as typeof zipService & { initializeOnboardingZipCleanup(options: { zipRoot: string; staleTtlMs: number }): Promise<void> }).initializeOnboardingZipCleanup({ zipRoot, staleTtlMs: 1_000 });

    await expect(readdir(staleDirectory)).rejects.toThrow();
    await expect(readdir(freshDirectory)).resolves.toContain("onboarding-kit.zip");
  });
});

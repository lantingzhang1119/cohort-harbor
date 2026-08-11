import { constants, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import { ZipArchive } from "archiver";

import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMaterialStatus } from "@/generated/prisma/enums";
import { createSafeDownloadName } from "@/features/onboarding-kit/download-name";
import { resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

export type OnboardingZipErrorCode = "EMPTY_SELECTION" | "TOO_MANY_ITEMS" | "TOTAL_TOO_LARGE" | "SELECTION_CHANGED" | "SOURCE_UNAVAILABLE" | "INSUFFICIENT_DISK_SPACE" | "BUILD_BUSY" | "ARCHIVE_FAILED";

export class OnboardingZipError extends Error {
  constructor(public readonly code: OnboardingZipErrorCode, message: string) {
    super(message);
    this.name = "OnboardingZipError";
  }
}

export type PreparedPrivateArchive = {
  path: string;
  sizeBytes: number;
  selections: PublishedMaterialSnapshot[];
  cleanup(): Promise<void>;
};

export type PublishedMaterialSnapshot = { materialId: string; currentVersionId: string };

type ZipBuildResources = { archive: ZipArchive; output: WriteStream };
type ZipHooks = { beforeFinalize?: (resources: ZipBuildResources) => void | Promise<void> };
type ZipOptions = {
  db: PrismaClient;
  privateRoot: string;
  zipRoot: string;
  materialIds: string[];
  maxItems: number;
  maxTotalBytes: number;
  maxConcurrentBuilds?: number;
  staleTtlMs?: number;
  availableBytes?: number;
  hooks?: ZipHooks;
};

const activeBuilds = new Map<string, number>();
const reservedBytes = new Map<string, number>();
const activeDirectories = new Map<string, Set<string>>();
const zipRootLocks = new Map<string, Promise<void>>();

async function withZipRootLock<T>(zipRoot: string, operation: () => Promise<T>) {
  const previous = zipRootLocks.get(zipRoot) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  zipRootLocks.set(zipRoot, tail);
  try {
    return await current;
  } finally {
    if (zipRootLocks.get(zipRoot) === tail) zipRootLocks.delete(zipRoot);
  }
}

function acquireBuildSlot(zipRoot: string, maxConcurrentBuilds: number) {
  const active = activeBuilds.get(zipRoot) ?? 0;
  if (active >= maxConcurrentBuilds) throw new OnboardingZipError("BUILD_BUSY", "资料包正在生成，请稍后重试");
  activeBuilds.set(zipRoot, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeBuilds.get(zipRoot) ?? 1) - 1;
    if (remaining <= 0) activeBuilds.delete(zipRoot); else activeBuilds.set(zipRoot, remaining);
  };
}

function acquireCapacityReservation(zipRoot: string, inputBytes: number, availableBytes: number) {
  const overheadBytes = Math.max(1024 * 1024, Math.ceil(inputBytes * 0.01));
  const requiredBytes = inputBytes + overheadBytes;
  const alreadyReserved = reservedBytes.get(zipRoot) ?? 0;
  if (availableBytes < alreadyReserved + requiredBytes) {
    throw new OnboardingZipError("INSUFFICIENT_DISK_SPACE", "服务器临时空间不足，请稍后重试或减少选择");
  }
  reservedBytes.set(zipRoot, alreadyReserved + requiredBytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (reservedBytes.get(zipRoot) ?? requiredBytes) - requiredBytes;
    if (remaining <= 0) reservedBytes.delete(zipRoot); else reservedBytes.set(zipRoot, remaining);
  };
}

function activeDirectorySet(zipRoot: string) {
  let directories = activeDirectories.get(zipRoot);
  if (!directories) {
    directories = new Set<string>();
    activeDirectories.set(zipRoot, directories);
  }
  return directories;
}

async function createActiveArchiveDirectory(zipRoot: string) {
  return withZipRootLock(zipRoot, async () => {
    const directory = await mkdtemp(path.join(/* turbopackIgnore: true */ zipRoot, "kit-"));
    activeDirectorySet(zipRoot).add(directory);
    return directory;
  });
}

async function removeActiveArchiveDirectory(zipRoot: string, directory: string) {
  await withZipRootLock(zipRoot, async () => {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      const directories = activeDirectories.get(zipRoot);
      directories?.delete(directory);
      if (directories?.size === 0) activeDirectories.delete(zipRoot);
    }
  });
}

function waitForClose(stream: ZipArchive | WriteStream) {
  if (stream.closed) return Promise.resolve();
  return new Promise<void>((resolve) => stream.once("close", resolve));
}

async function terminateArchive(archive: ZipArchive, output: WriteStream, sourceStreams: ReadStream[]) {
  const archiveClosed = waitForClose(archive);
  const outputClosed = waitForClose(output);
  try { archive.abort(); } catch { /* best-effort; destroy below is authoritative */ }
  archive.destroy();
  output.destroy();
  await Promise.all([archiveClosed, outputClosed]);
  await Promise.all(sourceStreams.map(async (stream) => {
    if (!stream.destroyed) stream.destroy();
    await finished(stream).catch(() => undefined);
  }));
}

export async function cleanStaleOnboardingArchives(zipRoot: string, ttlMs: number) {
  const normalizedRoot = path.resolve(/* turbopackIgnore: true */ zipRoot);
  await withZipRootLock(normalizedRoot, async () => {
    const entries = await readdir(normalizedRoot, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - ttlMs;
    const active = activeDirectories.get(normalizedRoot);
    await Promise.all(entries.filter((entry) => entry.name.startsWith("kit-")).map(async (entry) => {
      const target = path.join(/* turbopackIgnore: true */ normalizedRoot, entry.name);
      if (active?.has(target)) return;
      const information = await stat(target).catch(() => null);
      if (information && information.mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
    }));
  });
}

export async function initializeOnboardingZipCleanup(options: { zipRoot: string; staleTtlMs?: number }) {
  const zipRoot = path.resolve(/* turbopackIgnore: true */ options.zipRoot);
  await mkdir(zipRoot, { recursive: true, mode: 0o700 });
  await cleanStaleOnboardingArchives(zipRoot, options.staleTtlMs ?? 24 * 60 * 60 * 1000);
}

export async function publishedMaterialSnapshotsAreCurrent(db: PrismaClient, selections: PublishedMaterialSnapshot[]) {
  if (selections.length === 0) return false;
  const materials = await db.onboardingMaterial.findMany({
    where: {
      id: { in: selections.map((selection) => selection.materialId) },
      status: OnboardingMaterialStatus.PUBLISHED,
      deletedAt: null,
    },
    select: { id: true, currentVersionId: true },
  });
  if (materials.length !== selections.length) return false;
  const currentVersionIds = new Map(materials.map((material) => [material.id, material.currentVersionId]));
  return selections.every((selection) => currentVersionIds.get(selection.materialId) === selection.currentVersionId);
}

function zipEntryName(category: string, fileName: string, emittedNames: Set<string>) {
  const folder = createSafeDownloadName(category, "其他");
  const safeFile = createSafeDownloadName(fileName, "资料");
  const extension = path.extname(safeFile);
  const stem = safeFile.slice(0, Math.max(0, safeFile.length - extension.length)) || "资料";
  let index = 1;
  let emittedName: string;
  do {
    emittedName = `${folder}/${stem}${index === 1 ? "" : ` (${index})`}${extension}`;
    index += 1;
  } while (emittedNames.has(emittedName.toLocaleLowerCase("zh-CN")));
  emittedNames.add(emittedName.toLocaleLowerCase("zh-CN"));
  return emittedName;
}

export async function buildOnboardingZip(options: ZipOptions): Promise<PreparedPrivateArchive> {
  const materialIds = [...new Set(options.materialIds.filter(Boolean))];
  if (materialIds.length === 0) throw new OnboardingZipError("EMPTY_SELECTION", "请至少选择一项资料");
  if (options.materialIds.length > options.maxItems || materialIds.length > options.maxItems) throw new OnboardingZipError("TOO_MANY_ITEMS", `单次最多下载 ${options.maxItems} 项资料`);
  const zipRoot = path.resolve(/* turbopackIgnore: true */ options.zipRoot);
  const maxConcurrentBuilds = options.maxConcurrentBuilds ?? 2;
  const releaseBuildSlot = acquireBuildSlot(zipRoot, maxConcurrentBuilds);
  let directory: string | undefined;
  const sourceHandles: FileHandle[] = [];
  const sourceStreams: ReadStream[] = [];
  let archive: ZipArchive | undefined;
  let output: WriteStream | undefined;
  let releaseReservation: (() => void) | undefined;
  try {
    const materials = await options.db.onboardingMaterial.findMany({
      where: {
        id: { in: materialIds },
        status: OnboardingMaterialStatus.PUBLISHED,
        deletedAt: null,
      },
      include: { currentVersion: { include: { fileAsset: true } } },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
    });
    if (
      materials.length !== materialIds.length
      || materials.some((material) => !material.currentVersion || material.currentVersion.deletedAt)
    ) {
      throw new OnboardingZipError("SELECTION_CHANGED", "部分资料已下架或发生变化，请刷新后重试");
    }

    let totalBytes = 0;
    const sources: Array<{ path: string; entryName: string; sizeBytes: number; materialId: string; currentVersionId: string }> = [];
    const emittedNames = new Set<string>();
    for (const material of materials) {
      const version = material.currentVersion!;
      const sourcePath = await resolvePrivateAssetPathSecure(version.fileAsset.storageKey, options.privateRoot);
      if (!sourcePath) throw new OnboardingZipError("SOURCE_UNAVAILABLE", `资料“${material.title}”的文件不可用`);
      const information = await lstat(/* turbopackIgnore: true */ sourcePath).catch(() => null);
      if (!information?.isFile() || information.isSymbolicLink() || information.size !== version.sizeBytes) {
        throw new OnboardingZipError("SOURCE_UNAVAILABLE", `资料“${material.title}”的文件不可用`);
      }
      totalBytes += information.size;
      if (totalBytes > options.maxTotalBytes) throw new OnboardingZipError("TOTAL_TOO_LARGE", "所选资料总大小超过单次下载限制");
      sources.push({ path: sourcePath, entryName: zipEntryName(material.category, version.displayName || version.originalName, emittedNames), sizeBytes: information.size, materialId: material.id, currentVersionId: version.id });
    }

    await mkdir(zipRoot, { recursive: true, mode: 0o700 });
    await cleanStaleOnboardingArchives(zipRoot, options.staleTtlMs ?? 24 * 60 * 60 * 1000);
    const availableBytes = options.availableBytes !== undefined
      ? options.availableBytes
      : await statfs(zipRoot).then((value) => Number(value.bavail) * Number(value.bsize));
    releaseReservation = acquireCapacityReservation(zipRoot, totalBytes, availableBytes);

    directory = await createActiveArchiveDirectory(zipRoot);
    const archivePath = path.join(/* turbopackIgnore: true */ directory, "onboarding-kit.zip");
    output = createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
    archive = new ZipArchive({ zlib: { level: 6 } });
    let archiveFailed = false;
    let rejectArchiveFailure!: (reason: unknown) => void;
    const archiveError = new Promise<never>((_resolve, reject) => {
      rejectArchiveFailure = reject;
    });
    void archiveError.catch(() => undefined);
    const failArchive = (error: unknown) => {
      if (archiveFailed) return;
      archiveFailed = true;
      rejectArchiveFailure(error);
    };
    archive.on("error", failArchive);
    archive.on("warning", failArchive);
    output.on("error", failArchive);
    archive.pipe(output);
    for (const source of sources) {
      const sourceHandle = await open(/* turbopackIgnore: true */ source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openedStats = await sourceHandle.stat();
      if (!openedStats.isFile() || openedStats.size !== source.sizeBytes) {
        await sourceHandle.close();
        throw new OnboardingZipError("SOURCE_UNAVAILABLE", "资料源文件在打包前发生变化");
      }
      sourceHandles.push(sourceHandle);
      const sourceStream = sourceHandle.createReadStream({ autoClose: false });
      sourceStreams.push(sourceStream);
      archive.append(sourceStream, { name: source.entryName });
    }
    await Promise.race([Promise.resolve(options.hooks?.beforeFinalize?.({ archive, output })), archiveError]);
    const completion = Promise.all([archive.finalize(), finished(output)]);
    void completion.catch(failArchive);
    await Promise.race([completion, archiveError]);
    const information = await stat(archivePath);
    if (!information.isFile() || information.size <= 0) throw new Error("EMPTY_ARCHIVE");
    const cleanupDirectory = directory;
    const releasePreparedReservation = releaseReservation;
    releaseReservation = undefined;
    let cleanupPromise: Promise<void> | undefined;
    return {
      path: archivePath,
      sizeBytes: information.size,
      selections: sources.map(({ materialId, currentVersionId }) => ({ materialId, currentVersionId })),
      cleanup() {
        cleanupPromise ??= (async () => {
          try {
            await removeActiveArchiveDirectory(zipRoot, cleanupDirectory);
          } finally {
            releasePreparedReservation();
          }
        })();
        return cleanupPromise;
      },
    };
  } catch (error) {
    if (archive && output) await terminateArchive(archive, output, sourceStreams);
    if (directory) await removeActiveArchiveDirectory(zipRoot, directory);
    if (error instanceof OnboardingZipError) throw error;
    throw new OnboardingZipError("ARCHIVE_FAILED", "资料包生成失败，请稍后重试");
  } finally {
    await Promise.all(sourceHandles.map((handle) => handle.close().catch(() => undefined)));
    releaseReservation?.();
    releaseBuildSlot();
  }
}

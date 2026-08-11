import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

export type StagedPrivateUpload = {
  stagedPath: string;
  sizeBytes: number;
  sha256: string;
  cleanup(): Promise<void>;
};

export type StoredPrivateUpload = {
  storageKey: string;
  absolutePath: string;
  cleanup(): Promise<void>;
};

export class PrivateUploadValidationError extends Error {
  constructor(
    public readonly code: "FILE_TOO_LARGE" | "INVALID_STREAM" | "STORAGE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "PrivateUploadValidationError";
  }
}

const activeUploadDirectories = new Set<string>();
const MAIL_VALIDATION_SUBDIRECTORY = path.join("tmp", "mail-validation");
export const DEFAULT_PRIVATE_UPLOAD_STALE_MS = 24 * 60 * 60 * 1_000;

export function resolveMailValidationTempRoot(
  privateRoot: string,
  tempRoot = path.join(privateRoot, MAIL_VALIDATION_SUBDIRECTORY),
): string {
  const root = path.resolve(privateRoot);
  const resolved = path.resolve(tempRoot);
  if (root === path.parse(root).root) {
    throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "private storage root cannot be a filesystem root");
  }
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "mail validation temp root must stay below private storage root");
  }
  return resolved;
}

export async function prepareMailValidationTempRoot(
  privateRoot: string,
  tempRoot?: string,
): Promise<string> {
  const root = path.resolve(privateRoot);
  const resolved = resolveMailValidationTempRoot(root, tempRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let information = await lstat(current).catch(() => null);
    if (!information) {
      await mkdir(current, { mode: 0o700 });
      information = await lstat(current);
    }
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "mail validation temp root must not contain symlinks");
    }
  }
  const [realRoot, realTempRoot] = await Promise.all([realpath(root), realpath(resolved)]);
  const realRelative = path.relative(realRoot, realTempRoot);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "mail validation temp root escaped private storage");
  }
  return realTempRoot;
}

async function belongsToLiveProcess(directory: string): Promise<boolean> {
  const raw = await readFile(path.join(directory, ".active-pid"), "utf8").catch(() => "");
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export async function cleanupStalePrivateUploads(options: {
  privateRoot: string;
  tempRoot?: string;
  now?: () => Date;
  staleAfterMs?: number;
  maxEntries?: number;
  maxRemovals?: number;
}): Promise<{ scanned: number; removed: number }> {
  const tempRoot = await prepareMailValidationTempRoot(options.privateRoot, options.tempRoot);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PRIVATE_UPLOAD_STALE_MS;
  const maxEntries = options.maxEntries ?? 500;
  const maxRemovals = options.maxRemovals ?? 100;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new RangeError("staleAfterMs must be a positive integer");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError("maxEntries must be a positive integer");
  if (!Number.isSafeInteger(maxRemovals) || maxRemovals <= 0) throw new RangeError("maxRemovals must be a positive integer");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const cutoff = (options.now ?? (() => new Date()))().getTime() - staleAfterMs;
  let scanned = 0;
  let removed = 0;
  const directory = await opendir(tempRoot);
  try {
    for await (const entry of directory) {
      if (scanned >= maxEntries || removed >= maxRemovals) break;
      scanned += 1;
      if (!entry.isDirectory() || !/^cohort-harbor-upload-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const candidate = path.join(tempRoot, entry.name);
      if (activeUploadDirectories.has(candidate)) continue;
      if (await belongsToLiveProcess(candidate)) continue;
      const directoryStats = await stat(candidate).catch(() => null);
      if (!directoryStats?.isDirectory()) continue;
      const payloadStats = await stat(path.join(candidate, "payload")).catch(() => null);
      const lastTouched = Math.max(directoryStats.mtimeMs, payloadStats?.mtimeMs ?? 0);
      if (lastTouched >= cutoff) continue;
      await rm(candidate, { recursive: true, force: true });
      removed += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { scanned, removed };
}

export async function stagePrivateUpload(
  file: UploadFileLike,
  options: { maxBytes: number; tempRoot?: string },
): Promise<StagedPrivateUpload> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > options.maxBytes) {
    throw new PrivateUploadValidationError("FILE_TOO_LARGE", "文件超过上传大小限制");
  }

  const base = path.resolve(options.tempRoot ?? tmpdir());
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, "cohort-harbor-upload-"));
  activeUploadDirectories.add(directory);
  const stagedPath = path.join(directory, "payload");
  const digest = createHash("sha256");
  let sizeBytes = 0;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      activeUploadDirectories.delete(directory);
    }
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    handle = await open(stagedPath, "wx", 0o600);
    await writeFile(path.join(directory, ".active-pid"), String(process.pid), { flag: "wx", mode: 0o600 });
    reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new PrivateUploadValidationError("INVALID_STREAM", "上传数据流无效");
      }
      sizeBytes += value.byteLength;
      if (sizeBytes > options.maxBytes) {
        throw new PrivateUploadValidationError("FILE_TOO_LARGE", "文件超过上传大小限制");
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (bytesWritten <= 0) throw new PrivateUploadValidationError("INVALID_STREAM", "上传数据写入失败");
        offset += bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { stagedPath, sizeBytes, sha256: digest.digest("hex"), cleanup };
  } catch (error) {
    await reader?.cancel(error).catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await cleanup();
    throw error;
  }
}

export async function storeStagedPrivateUpload(
  stagedPath: string,
  options: { privateRoot: string; namespace: string; extension: string },
): Promise<StoredPrivateUpload> {
  const privateRoot = path.resolve(options.privateRoot);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const namespace = options.namespace.replaceAll("\\", "/");
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(namespace) || namespace.includes("..")) {
    throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "私有存储命名空间无效");
  }
  const directory = path.join(privateRoot, ...namespace.split("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storageKey = path.posix.join(namespace, `${randomUUID()}${options.extension}`);
  const absolutePath = await resolvePrivateAssetPathSecure(storageKey, privateRoot, { allowMissingLeaf: true });
  if (!absolutePath) throw new PrivateUploadValidationError("STORAGE_UNAVAILABLE", "私有存储路径无效");
  await copyFile(stagedPath, absolutePath, constants.COPYFILE_EXCL);
  let cleaned = false;
  return {
    storageKey,
    absolutePath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(absolutePath, { force: true });
    },
  };
}

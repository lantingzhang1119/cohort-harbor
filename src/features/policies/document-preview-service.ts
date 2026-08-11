import "server-only";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind, PolicyPreviewStatus } from "@/generated/prisma/enums";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

const execFileAsync = promisify(execFile);
const BUNDLED_CHINESE_FONT_FILE = "NotoSansCJKsc-Regular.otf";
const BUNDLED_CHINESE_FONT_FAMILY = "Noto Sans CJK SC";

export type OfficePreviewConverter = (
  inputPath: string,
  workDirectory: string,
  options: { sofficePath?: string; timeoutMs: number; fontDirectory?: string },
) => Promise<Uint8Array>;

export type PolicyPreviewOptions = {
  privateRoot?: string;
  sofficePath?: string;
  fontDirectory?: string;
  timeoutMs?: number;
  officeConverter?: OfficePreviewConverter;
};

type PreviewArtifact = {
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
  format: "PDF" | "IMAGE" | "CSV" | "TEXT";
  metadata: Record<string, string | number | null>;
};

async function pdfMetadata(bytes: Uint8Array) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
    const document = await loadingTask.promise;
    const pages = document.numPages;
    await loadingTask.destroy();
    return { pages };
  } catch {
    return { pages: null };
  }
}

function previewStrategy(extension: string) {
  if (extension === ".pdf") return "PDF" as const;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return "IMAGE" as const;
  if (extension === ".csv") return "CSV" as const;
  if (extension === ".txt") return "TEXT" as const;
  return "OFFICE" as const;
}

function decodeCommonText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  }
}

async function locateSoffice(explicitPath?: string) {
  const bundledRuntimeSoffice = path.resolve(
    path.dirname(process.execPath),
    "..",
    "..",
    "bin",
    "override",
    "soffice",
  );
  const candidates = [
    explicitPath,
    process.env.SOFFICE_PATH,
    bundledRuntimeSoffice,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return "soffice";
}

async function locateChineseFontDirectory(explicitDirectory?: string) {
  const candidates = [
    explicitDirectory,
    process.env.OFFICE_FONT_DIRECTORY,
    path.resolve(process.cwd(), "vendor", "fonts"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const absoluteDirectory = path.resolve(candidate);
    const fontPath = path.join(absoluteDirectory, BUNDLED_CHINESE_FONT_FILE);
    if (await access(fontPath).then(() => true).catch(() => false)) return absoluteDirectory;
  }
  return null;
}

function escapeFontConfigValue(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fontConfigContents(fontDirectory: string, cacheDirectory: string) {
  const aliases = [
    "SimSun",
    "宋体",
    "SimHei",
    "黑体",
    "Microsoft YaHei",
    "微软雅黑",
    "FangSong",
    "仿宋",
    "KaiTi",
    "楷体",
    "DengXian",
    "等线",
  ];
  const aliasRules = aliases.map((family) => `
  <match target="pattern">
    <test name="family" compare="eq"><string>${escapeFontConfigValue(family)}</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${BUNDLED_CHINESE_FONT_FAMILY}</string></edit>
  </match>`).join("");
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${escapeFontConfigValue(fontDirectory)}</dir>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir>/usr/share/fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir>${escapeFontConfigValue(cacheDirectory)}</cachedir>${aliasRules}
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="append"><string>${BUNDLED_CHINESE_FONT_FAMILY}</string></edit>
  </match>
</fontconfig>
`;
}

export async function prepareOfficeConversionRuntime(
  workDirectory: string,
  options: { fontDirectory?: string } = {},
) {
  const fontDirectory = await locateChineseFontDirectory(options.fontDirectory);
  if (!fontDirectory) {
    throw new Error(`中文预览字体缺失：请部署 vendor/fonts/${BUNDLED_CHINESE_FONT_FILE}`);
  }
  const profileDirectory = path.join(workDirectory, "libreoffice-profile");
  const fontConfigDirectory = path.join(workDirectory, "fontconfig");
  const fontCacheDirectory = path.join(workDirectory, "font-cache");
  await Promise.all([
    mkdir(profileDirectory, { recursive: true }),
    mkdir(fontConfigDirectory, { recursive: true }),
    mkdir(fontCacheDirectory, { recursive: true }),
  ]);
  await writeFile(
    path.join(fontConfigDirectory, "fonts.conf"),
    fontConfigContents(fontDirectory, fontCacheDirectory),
    "utf8",
  );
  return {
    userInstallationArg: `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
    env: {
      ...process.env,
      FONTCONFIG_PATH: fontConfigDirectory,
      FONTCONFIG_FILE: "fonts.conf",
      SAL_FONTPATH: fontDirectory,
    },
  };
}

export async function convertOfficeToPdf(
  inputPath: string,
  workDirectory: string,
  options: { sofficePath?: string; timeoutMs: number; fontDirectory?: string },
) {
  const executable = await locateSoffice(options.sofficePath);
  const runtime = await prepareOfficeConversionRuntime(workDirectory, options);
  await execFileAsync(executable, [
    runtime.userInstallationArg,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    workDirectory,
    inputPath,
  ], {
    env: runtime.env,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const outputPath = path.join(
    workDirectory,
    `${path.basename(inputPath, path.extname(inputPath))}.pdf`,
  );
  const bytes = new Uint8Array(await readFile(outputPath));
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("LibreOffice 未生成有效的 PDF 预览");
  }
  return bytes;
}

async function buildPreviewArtifact(
  originalPath: string,
  originalMimeType: string,
  options: PolicyPreviewOptions,
): Promise<PreviewArtifact> {
  const extension = path.extname(originalPath).toLowerCase();
  const strategy = previewStrategy(extension);
  if (strategy === "PDF") {
    const bytes = new Uint8Array(await readFile(originalPath));
    return { bytes, extension: ".pdf", mimeType: "application/pdf", format: "PDF", metadata: await pdfMetadata(bytes) };
  }
  if (strategy === "IMAGE") {
    const bytes = new Uint8Array(await readFile(originalPath));
    const image = await import("sharp").then(({ default: sharp }) => sharp(bytes).metadata()).catch(() => null);
    return { bytes, extension, mimeType: originalMimeType, format: "IMAGE", metadata: { width: image?.width ?? null, height: image?.height ?? null, frames: image?.pages ?? 1 } };
  }
  if (strategy === "CSV" || strategy === "TEXT") {
    const decoded = decodeCommonText(new Uint8Array(await readFile(originalPath))).replace(/\r\n?/g, "\n");
    return {
      bytes: new TextEncoder().encode(decoded),
      extension,
      mimeType: strategy === "CSV" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
      format: strategy,
      metadata: strategy === "CSV"
        ? { rows: decoded ? decoded.split("\n").length : 0, columns: decoded.split("\n")[0]?.split(",").length ?? 0, encoding: "utf-8" }
        : { lines: decoded ? decoded.split("\n").length : 0, characters: decoded.length, encoding: "utf-8" },
    };
  }
  const workDirectory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-policy-preview-"));
  try {
    const converter = options.officeConverter ?? convertOfficeToPdf;
    const bytes = await converter(originalPath, workDirectory, {
      sofficePath: options.sofficePath,
      fontDirectory: options.fontDirectory,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    return { bytes, extension: ".pdf", mimeType: "application/pdf", format: "PDF", metadata: { ...(await pdfMetadata(bytes)), source: "libreoffice" } };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function generatePolicyPreview(
  db: PrismaClient,
  versionId: string,
  options: PolicyPreviewOptions = {},
) {
  const privateRoot = options.privateRoot ?? defaultPrivateRoot;
  await db.policyVersion.update({
    where: { id: versionId },
    data: { previewStatus: PolicyPreviewStatus.PROCESSING, previewError: null },
  });
  let previewPath: string | null = null;
  try {
    const version = await db.policyVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: { fileAsset: true, previewAsset: true },
    });
    const originalPath = await resolvePrivateAssetPathSecure(version.fileAsset.storageKey, privateRoot);
    if (!originalPath) throw new Error("制度原文件不存在或路径不安全");
    const artifact = await buildPreviewArtifact(originalPath, version.fileAsset.mimeType, options);
    const storageKey = path.posix.join(
      "assets",
      "policies",
      "previews",
      `${randomUUID()}${artifact.extension}`,
    );
    previewPath = path.resolve(privateRoot, storageKey);
    await mkdir(path.dirname(previewPath), { recursive: true });
    await writeFile(previewPath, artifact.bytes);
    const previousPreview = version.previewAsset;
    const result = await db.$transaction(async (transaction) => {
      const asset = await transaction.fileAsset.create({
        data: {
          kind: FileAssetKind.POLICY_PREVIEW,
          storageKey,
          originalName: `${path.parse(version.fileAsset.originalName).name}-preview${artifact.extension}`,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.bytes.byteLength,
          sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
          uploadedById: version.fileAsset.uploadedById,
          uploadedBySnapshot: version.fileAsset.uploadedBySnapshot as Prisma.InputJsonValue,
        },
      });
      const updated = await transaction.policyVersion.update({
        where: { id: versionId },
        data: {
          previewStatus: PolicyPreviewStatus.READY,
          previewAssetId: asset.id,
          previewFormat: artifact.format,
          previewMetadata: artifact.metadata,
          previewError: null,
          previewGeneratedAt: new Date(),
        },
      });
      if (previousPreview && previousPreview.kind === FileAssetKind.POLICY_PREVIEW) {
        await transaction.fileAsset.delete({ where: { id: previousPreview.id } });
      }
      return updated;
    });
    if (previousPreview && previousPreview.kind === FileAssetKind.POLICY_PREVIEW) {
      const oldPath = await resolvePrivateAssetPathSecure(previousPreview.storageKey, privateRoot);
      if (oldPath) await unlink(oldPath).catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (previewPath) await unlink(previewPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : "预览生成失败";
    return db.policyVersion.update({
      where: { id: versionId },
      data: {
        previewStatus: PolicyPreviewStatus.FAILED,
        previewAssetId: null,
        previewFormat: null,
        previewMetadata: Prisma.DbNull,
        previewError: message.slice(0, 500),
        previewGeneratedAt: null,
      },
    });
  }
}

export async function checkPolicyPreviewEnvironment(options: { sofficePath?: string; fontDirectory?: string } = {}) {
  const fontDirectory = await locateChineseFontDirectory(options.fontDirectory);
  const chineseFontAvailable = Boolean(fontDirectory);
  try {
    const executable = await locateSoffice(options.sofficePath);
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    return { available: true, executable, version: `${stdout}${stderr}`.trim(), chineseFontAvailable, fontDirectory };
  } catch (error) {
    return { available: false, executable: options.sofficePath ?? "soffice", chineseFontAvailable, fontDirectory, error: error instanceof Error ? error.message : "检测失败" };
  }
}

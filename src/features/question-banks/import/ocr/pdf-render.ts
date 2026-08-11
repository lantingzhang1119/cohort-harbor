import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderedPdfPage = {
  page: number;
  absolutePath: string;
};

export type RenderedPdfResult = {
  pages: RenderedPdfPage[];
  workDirectory: string;
  cleanup(): Promise<void>;
};

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false);
}

/**
 * Resolve a bare command name (or absolute path) to an executable absolute path.
 * Bare names must be resolved before companion fontconfig discovery.
 */
async function resolveExecutable(candidate: string): Promise<string | null> {
  if (!candidate) return null;
  if (path.isAbsolute(candidate)) {
    return (await pathExists(candidate)) ? candidate : null;
  }
  if (candidate.includes("/") || candidate.includes(path.sep)) {
    const resolved = path.resolve(candidate);
    return (await pathExists(resolved)) ? resolved : null;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const fullPath = path.join(directory, candidate);
    if (await pathExists(fullPath)) return fullPath;
  }
  return null;
}

async function locatePdftoppm(explicitPath?: string) {
  const candidates = [
    explicitPath,
    process.env.PDFTOPPM_PATH,
    // Bundled runtimes place native tools next to the active Node.js tree.
    path.resolve(path.dirname(process.execPath), "..", "..", "bin", "override", "pdftoppm"),
    "/opt/homebrew/bin/pdftoppm",
    "/usr/local/bin/pdftoppm",
    "pdftoppm",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return "pdftoppm";
}

function escapeFontConfigValue(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeFallbackFontconfig(cacheDirectory: string): Promise<string> {
  const configPath = path.join(cacheDirectory, "fonts.conf");
  const contents = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir>/opt/homebrew/share/fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir>${escapeFontConfigValue(cacheDirectory)}</cachedir>
</fontconfig>
`;
  await writeFile(configPath, contents, "utf8");
  return configPath;
}

async function resolveFontconfigEnvironment(executable: string, cacheDirectory: string) {
  // Respect an explicit host config only when the file actually exists.
  if (process.env.FONTCONFIG_FILE && (await pathExists(process.env.FONTCONFIG_FILE))) {
    return {
      ...process.env,
      XDG_CACHE_HOME: cacheDirectory,
    };
  }

  const absoluteExecutable = path.isAbsolute(executable)
    ? executable
    : (await resolveExecutable(executable)) ?? executable;

  const candidates = path.isAbsolute(absoluteExecutable)
    ? [
        // Bundled override wrapper: .../bin/override/pdftoppm
        path.resolve(
          path.dirname(absoluteExecutable),
          "..",
          "..",
          "native",
          "poppler",
          "poppler",
          "etc",
          "fonts",
          "fonts.conf",
        ),
        // Real poppler binary: .../native/poppler/bin/pdftoppm
        path.resolve(path.dirname(absoluteExecutable), "..", "poppler", "etc", "fonts", "fonts.conf"),
        path.resolve(path.dirname(absoluteExecutable), "..", "etc", "fonts", "fonts.conf"),
      ]
    : [];

  candidates.push(
    "/opt/homebrew/etc/fonts/fonts.conf",
    "/usr/local/etc/fonts/fonts.conf",
    "/etc/fonts/fonts.conf",
  );

  let fontconfigFile: string | null = null;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      fontconfigFile = candidate;
      break;
    }
  }

  if (!fontconfigFile) {
    fontconfigFile = await writeFallbackFontconfig(cacheDirectory);
  }

  return {
    ...process.env,
    XDG_CACHE_HOME: cacheDirectory,
    FONTCONFIG_FILE: fontconfigFile,
    FONTCONFIG_PATH: path.dirname(fontconfigFile),
  };
}

export async function renderPdfPagesToPng(
  pdfPath: string,
  options: {
    workDirectory: string;
    timeoutMs?: number;
    pdftoppmPath?: string;
    resolution?: number;
    firstPage?: number;
    lastPage?: number;
  },
): Promise<RenderedPdfResult> {
  const workDirectory = path.resolve(options.workDirectory);
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const executable = await locatePdftoppm(options.pdftoppmPath);
  const prefix = path.join(workDirectory, "page");
  const cacheDirectory = path.join(workDirectory, ".cache");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const timeoutMs = options.timeoutMs ?? 60_000;
  const resolution = options.resolution ?? 150;
  const firstPage = options.firstPage ?? 1;
  const lastPage = options.lastPage;
  if (!Number.isSafeInteger(firstPage) || firstPage < 1) throw new RangeError("firstPage must be positive");
  if (lastPage !== undefined && (!Number.isSafeInteger(lastPage) || lastPage < firstPage)) {
    throw new RangeError("lastPage must not be before firstPage");
  }
  if (!Number.isFinite(resolution) || resolution < 72 || resolution > 300) {
    throw new RangeError("resolution must be between 72 and 300 DPI");
  }

  const args = ["-png", "-r", String(resolution), "-f", String(firstPage)];
  if (lastPage !== undefined) args.push("-l", String(lastPage));
  args.push(pdfPath, prefix);

  try {
    const env = await resolveFontconfigEnvironment(executable, cacheDirectory);
    await execFileAsync(
      executable,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env,
      },
    );
  } catch (error) {
    await rm(workDirectory, { recursive: true, force: true });
    throw error;
  }

  const files = (await readdir(workDirectory))
    .filter((name) => /^page-\d+\.png$/i.test(name) || /^page\d+\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const pages: RenderedPdfPage[] = files.map((name, index) => ({
    page: index + 1,
    absolutePath: path.join(workDirectory, name),
  }));

  if (!pages.length) {
    await rm(workDirectory, { recursive: true, force: true });
    throw new Error("pdftoppm 未生成页面图像");
  }

  let cleaned = false;
  return {
    pages,
    workDirectory,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(workDirectory, { recursive: true, force: true });
    },
  };
}

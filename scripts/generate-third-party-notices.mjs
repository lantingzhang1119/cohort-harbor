import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Usage: node scripts/generate-third-party-notices.mjs [--input licenses.json] [--output THIRD_PARTY_NOTICES.md]");
    }
    values.set(key, value);
  }
  return values;
}

function cleanInline(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compareText(left, right) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

export function renderThirdPartyNotices(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("The pnpm license report must be an object grouped by license expression.");
  }

  const sections = Object.entries(report)
    .map(([expression, packages]) => {
      if (!Array.isArray(packages)) {
        throw new TypeError(`License group ${expression} must be an array.`);
      }
      return [cleanInline(expression), [...packages].sort((left, right) => compareText(cleanInline(left.name), cleanInline(right.name)))];
    })
    .sort(([left], [right]) => compareText(left, right));

  const packageCount = sections.reduce((total, [, packages]) => total + packages.length, 0);
  const lines = [
    "# Third-Party Notices",
    "",
    "CohortHarbor is distributed under the MIT License. Its dependency graph and vendored assets include third-party works under their own licenses. This inventory is generated from `pnpm licenses list --json`; package paths are intentionally omitted so local developer paths never enter the repository.",
    "",
    `Dependency groups: ${sections.length}. Package records: ${packageCount}.`,
    "",
    "## Vendored assets",
    "",
    "- **Noto Sans CJK SC Regular** — SIL Open Font License 1.1 — <https://github.com/notofonts/noto-cjk> — license text: `LICENSES/OFL-1.1.txt`.",
    "- **Tesseract `chi_sim` and `eng` fast trained data** — Apache License 2.0 — <https://github.com/tesseract-ocr/tessdata_fast> — license text: `LICENSES/Apache-2.0.txt`.",
    "",
    "## Dependency inventory",
    "",
  ];

  for (const [expression, packages] of sections) {
    lines.push(`## ${expression}`, "");
    for (const entry of packages) {
      const name = cleanInline(entry.name);
      const versions = [...new Set((entry.versions ?? []).map(cleanInline).filter(Boolean))].sort(compareText);
      if (!name || versions.length === 0) {
        throw new TypeError(`License group ${expression} contains a package without a name or version.`);
      }
      lines.push(`- **${name}@${versions.join(", ")}**`);
      const author = cleanInline(entry.author);
      const homepage = cleanInline(entry.homepage);
      if (author || homepage) {
        lines.push(`  - Attribution: ${[author, homepage].filter(Boolean).join(" — ")}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "## Compliance note",
    "",
    "This file is an attribution aid, not a replacement for the license texts shipped by each package. The lockfile and `sbom.spdx.json` are the machine-readable dependency records. No GPL, AGPL, or LGPL source code is vendored by this project; platform-specific transitive binaries remain subject to their upstream licenses.",
    "",
  );
  return lines.join("\n");
}

async function loadReport(inputPath) {
  if (inputPath) {
    return JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
  }
  const result = spawnSync("pnpm", ["licenses", "list", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`pnpm licenses list failed with exit ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = await loadReport(args.get("--input"));
  const outputPath = path.resolve(args.get("--output") ?? "THIRD_PARTY_NOTICES.md");
  await writeFile(outputPath, renderThirdPartyNotices(report), "utf8");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

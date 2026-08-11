import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Usage: node scripts/verify-spdx-sbom.mjs --expected sbom.spdx.json --actual generated.spdx.json");
    }
    values.set(key, value);
  }
  if (!values.get("--expected") || !values.get("--actual")) {
    throw new Error("Both --expected and --actual are required.");
  }
  return values;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function stablePackage(entry) {
  return sortJson({
    SPDXID: entry.SPDXID,
    name: entry.name,
    versionInfo: entry.versionInfo,
    downloadLocation: entry.downloadLocation,
    filesAnalyzed: entry.filesAnalyzed,
    primaryPackagePurpose: entry.primaryPackagePurpose,
    licenseConcluded: entry.licenseConcluded,
    licenseDeclared: entry.licenseDeclared,
    copyrightText: entry.copyrightText,
    description: entry.description,
    homepage: entry.homepage,
    checksums: entry.checksums ?? [],
    externalRefs: entry.externalRefs ?? [],
  });
}

function inventory(document, sourceName) {
  if (!document || typeof document !== "object" || !String(document.spdxVersion ?? "").startsWith("SPDX-2.")) {
    throw new Error(`${sourceName} is not an SPDX 2.x JSON document.`);
  }
  if (document.name !== "cohort-harbor" || !Array.isArray(document.packages)) {
    throw new Error(`${sourceName} must describe cohort-harbor and include packages.`);
  }
  const serialized = JSON.stringify(document);
  if (/(?:\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\Users\\)/i.test(serialized)) {
    throw new Error(`${sourceName} contains a local absolute path.`);
  }
  return sortJson({
    name: document.name,
    packages: document.packages.map(stablePackage),
    relationships: document.relationships ?? [],
  });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadDocument(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const expected = inventory(await loadDocument(args.get("--expected")), "expected SBOM");
  const actual = inventory(await loadDocument(args.get("--actual")), "actual SBOM");
  const expectedDigest = digest(expected);
  const actualDigest = digest(actual);
  if (expectedDigest !== actualDigest) {
    throw new Error(`SBOM inventory mismatch: expected ${expected.packages.length} packages (${expectedDigest}), actual ${actual.packages.length} packages (${actualDigest}).`);
  }
  process.stdout.write(`SPDX SBOM inventory matches (${actual.packages.length} packages).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

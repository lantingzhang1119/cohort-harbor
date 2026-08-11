import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function sbom(namespace: string, created: string, dependencyVersion = "1.0.0") {
  return {
    spdxVersion: "SPDX-2.3",
    name: "cohort-harbor",
    documentNamespace: namespace,
    creationInfo: { created, creators: ["Tool: pnpm"] },
    packages: [
      { SPDXID: "SPDXRef-RootPackage", name: "cohort-harbor", versionInfo: "0.1.0", downloadLocation: "NOASSERTION" },
      { SPDXID: "SPDXRef-Package-example", name: "example", versionInfo: dependencyVersion, downloadLocation: "https://registry.npmjs.org/example" },
    ],
    relationships: [
      { spdxElementId: "SPDXRef-RootPackage", relationshipType: "DEPENDS_ON", relatedSpdxElement: "SPDXRef-Package-example" },
    ],
  };
}

async function runVerification(actualDependencyVersion = "1.0.0") {
  const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-sbom-"));
  const expected = path.join(directory, "expected.json");
  const actual = path.join(directory, "actual.json");
  await writeFile(expected, JSON.stringify(sbom("https://spdx.example/one", "2026-08-11T00:00:00Z")), "utf8");
  await writeFile(actual, JSON.stringify(sbom("https://spdx.example/two", "2026-08-12T00:00:00Z", actualDependencyVersion)), "utf8");
  return spawnSync(process.execPath, [
    "scripts/verify-spdx-sbom.mjs",
    "--expected",
    expected,
    "--actual",
    actual,
  ], { cwd: process.cwd(), encoding: "utf8" });
}

describe("SPDX SBOM verifier", () => {
  it("ignores volatile document metadata while comparing the package graph", async () => {
    const result = await runVerification();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects dependency-version drift", async () => {
    const result = await runVerification("2.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SBOM inventory mismatch");
  });
});

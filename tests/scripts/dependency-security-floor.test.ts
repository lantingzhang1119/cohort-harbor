import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("dependency security floor", () => {
  it("pins patched transitive versions reported by GitHub advisories", async () => {
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");
    const lockfile = await readFile("pnpm-lock.yaml", "utf8");
    const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workspace).toContain("  js-yaml: 4.3.1");
    expect(workspace).toContain("  undici: 7.29.0");
    expect(lockfile).toContain("js-yaml@4.3.1");
    expect(lockfile).not.toContain("js-yaml@4.3.0");
    expect(lockfile).toContain("undici@7.29.0");
    expect(lockfile).not.toContain("undici@7.28.0");
    expect(ciWorkflow).toContain("run: pnpm audit --audit-level high");
    expect(ciWorkflow).not.toContain("pnpm audit --prod");
  });
});

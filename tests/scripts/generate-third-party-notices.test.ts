import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("third-party notice generator", () => {
  it("renders deterministic attribution without installation paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cohort-harbor-notices-"));
    const input = path.join(directory, "licenses.json");
    const output = path.join(directory, "THIRD_PARTY_NOTICES.md");
    await writeFile(input, JSON.stringify({
      MIT: [
        {
          name: "zeta-package",
          versions: ["2.0.0", "1.0.0"],
          paths: ["/private/install/zeta-package"],
          license: "MIT",
          author: "Zeta Maintainers",
          homepage: "https://example.invalid/zeta",
        },
        {
          name: "alpha-package",
          versions: ["3.0.0"],
          paths: ["/private/install/alpha-package"],
          license: "MIT",
        },
      ],
      "Apache-2.0": [{
        name: "middle-package",
        versions: ["1.2.3"],
        paths: ["/private/install/middle-package"],
        license: "Apache-2.0",
        author: "Middle Authors",
      }],
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "scripts/generate-third-party-notices.mjs",
      "--input",
      input,
      "--output",
      output,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const rendered = await readFile(output, "utf8");
    expect(rendered).toContain("# Third-Party Notices");
    expect(rendered.indexOf("## Apache-2.0")).toBeLessThan(rendered.indexOf("## MIT"));
    expect(rendered.indexOf("alpha-package@3.0.0")).toBeLessThan(rendered.indexOf("zeta-package@1.0.0, 2.0.0"));
    expect(rendered).toContain("Zeta Maintainers — https://example.invalid/zeta");
    expect(rendered).not.toContain("/private/install");
  });
});

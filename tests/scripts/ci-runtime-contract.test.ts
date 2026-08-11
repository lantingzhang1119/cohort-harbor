import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("CI runtime contract", () => {
  it("installs the Linux OCR runtime and applies the Vitest worker limit", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const ocrTests = await readFile("tests/question-banks/import-ocr.test.ts", "utf8");

    expect(workflow).toContain("sudo apt-get install --no-install-recommends --yes fontconfig poppler-utils");
    expect(workflow).toContain("sudo install -m 0644 vendor/fonts/NotoSansCJKsc-Regular.otf");
    expect(workflow).toContain("sudo fc-cache -f");
    expect(workflow).toContain("pnpm test --maxWorkers=2");
    expect(workflow).not.toContain("pnpm test -- --maxWorkers");
    expect(ocrTests).toContain('font-family="Noto Sans CJK SC, Noto Sans SC');
  });
});

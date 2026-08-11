import { describe, expect, it } from "vitest";

import { normalizeE2eArgs } from "../../scripts/e2e-args.mjs";

describe("E2E wrapper argument normalization", () => {
  it("strips exactly one leading pnpm delimiter", () => {
    expect(
      normalizeE2eArgs(["--", "e2e/security.spec.ts", "--project=desktop-chromium"]),
    ).toEqual(["e2e/security.spec.ts", "--project=desktop-chromium"]);
    expect(normalizeE2eArgs(["--", "--", "e2e/security.spec.ts"])).toEqual([
      "--",
      "e2e/security.spec.ts",
    ]);
  });

  it("preserves arguments when there is no leading delimiter", () => {
    expect(normalizeE2eArgs(["e2e/security.spec.ts", "--project=desktop-chromium"])).toEqual([
      "e2e/security.spec.ts",
      "--project=desktop-chromium",
    ]);
  });
});

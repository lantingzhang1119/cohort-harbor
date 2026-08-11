import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("welcome-mail server-only boundary", () => {
  it.each([
    "asset-service.ts",
    "cc-service.ts",
    "message-size.ts",
    "template-renderer.ts",
    "template-service.ts",
  ])("marks %s as server-only", async (fileName) => {
    const source = await readFile(path.resolve("src/features/onboarding-mail", fileName), "utf8");
    expect(source).toMatch(/^import "server-only";/);
  });
});

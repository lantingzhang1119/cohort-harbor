import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/features/auth/password";

describe("password storage", () => {
  it("uses a fresh scrypt salt for every password", async () => {
    const first = await hashPassword("DemoPassword!23");
    const second = await hashPassword("DemoPassword!23");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  });

  it("accepts only the matching password", async () => {
    const stored = await hashPassword("DemoPassword!23");

    await expect(verifyPassword("DemoPassword!23", stored)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword!23", stored)).resolves.toBe(false);
  });

  it("safely rejects malformed stored values", async () => {
    await expect(verifyPassword("anything", "legacy-value")).resolves.toBe(false);
  });
});

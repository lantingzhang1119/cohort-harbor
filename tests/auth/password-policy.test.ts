import { describe, expect, it } from "vitest";

import {
  isValidNewPassword,
  newPasswordSchema,
  validateNewPassword,
} from "@/features/auth/password-policy";

describe("new password policy", () => {
  it.each([
    ["Abc1234", false],
    ["abcdefgh", false],
    ["12345678", false],
    ["abcd1234", true],
    ["Very-Long-Password-2026!", true],
  ])("validates %s", (password, expected) => {
    expect(isValidNewPassword(password)).toBe(expected);
    expect(newPasswordSchema.safeParse(password).success).toBe(expected);
    expect(validateNewPassword(password).success).toBe(expected);
  });
});

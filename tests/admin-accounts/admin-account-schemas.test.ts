import { describe, expect, it } from "vitest";

import {
  adminIdentityInputSchema,
  createAdminInputSchema,
} from "@/features/admin-accounts/schemas";

describe("administrator input schemas", () => {
  it.each([
    ["create", createAdminInputSchema, { employeeNo: "ADMIN-LONG", name: "管".repeat(81), email: "admin@example.invalid" }],
    ["identity", adminIdentityInputSchema, {
      employeeNo: "ADMIN-LONG",
      name: "管".repeat(81),
      email: "admin@example.invalid",
      temporaryPassword: "password8A",
      currentPassword: "current-password",
    }],
  ] as const)("rejects an overlong real name in the %s flow", (_label, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

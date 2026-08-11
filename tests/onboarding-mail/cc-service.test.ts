import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role, UserSource } from "@/generated/prisma/enums";
import {
  CcResolutionError,
  resolveCcInput,
  resolveCcRecipients,
  searchCcCandidates,
  type CcEntry,
} from "@/features/onboarding-mail/cc-service";
import { createTestDatabase } from "../helpers/test-db";

async function account(db: PrismaClient, employeeNo: string, name: string, email: string | null) {
  return db.user.create({ data: {
    employeeNo,
    name,
    email,
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    passwordHash: "unused",
  } });
}

describe("welcome-mail CC identity and address resolution", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => { await testDb.cleanup(); });

  it("normalizes name and email searches and emits unambiguous identity labels", async () => {
    const alice = await account(testDb.db, "E-ALICE", "Alice Zhang", "Alice.Zhang@example.invalid");
    expect(await searchCcCandidates("  alice   zhang ", { db: testDb.db })).toEqual([
      expect.objectContaining({ userId: alice.id, employeeNo: "E-ALICE", label: "Alice Zhang（E-ALICE · Alice.Zhang@example.invalid）" }),
    ]);
    expect(await searchCcCandidates(" ALICE.ZHANG@example.invalid ", { db: testDb.db })).toEqual([
      expect.objectContaining({ userId: alice.id }),
    ]);
  });

  it("requires identity selection for duplicate normalized names", async () => {
    await account(testDb.db, "E-001", "示例员工", "zhang1@example.invalid");
    await account(testDb.db, "E-002", " 示例员工 ", "zhang2@example.invalid");

    await expect(resolveCcInput("示例员工", { db: testDb.db })).rejects.toMatchObject({
      code: "AMBIGUOUS_NAME",
      candidates: [
        expect.objectContaining({ employeeNo: "E-001", label: expect.stringContaining("E-001") }),
        expect.objectContaining({ employeeNo: "E-002", label: expect.stringContaining("E-002") }),
      ],
    });
  });

  it("auto-detects internal account emails and fixed external addresses", async () => {
    const manager = await account(testDb.db, "M-001", "直属经理", "Manager@example.invalid");
    await expect(resolveCcInput(" manager@example.invalid ", { db: testDb.db })).resolves.toEqual({
      kind: "USER", userId: manager.id, displayName: "直属经理",
    });
    await expect(resolveCcInput(" Consultant@outside.example.invalid ", { db: testDb.db })).resolves.toEqual({
      kind: "EMAIL", email: "consultant@outside.example.invalid", displayName: undefined,
    });
    await expect(resolveCcInput("broken@", { db: testDb.db }))
      .rejects.toMatchObject({ code: "INVALID_EMAIL" });
  });

  it("late-binds account email, keeps external addresses fixed, dedupes case-insensitively and removes the recipient", async () => {
    const manager = await account(testDb.db, "M-002", "经理", "old@example.invalid");
    await testDb.db.user.update({ where: { id: manager.id }, data: { email: "Current.Manager@example.invalid" } });
    const entries: CcEntry[] = [
      { kind: "USER", userId: manager.id, displayName: "发布时经理", sortOrder: 30 },
      { kind: "EMAIL", email: "current.manager@example.invalid", displayName: "重复地址", sortOrder: 40 },
      { kind: "EMAIL", email: " External@outside.example.invalid ", displayName: "外部顾问", sortOrder: 10 },
      { kind: "EMAIL", email: "external@outside.example.invalid", displayName: "重复外部", sortOrder: 20 },
      { kind: "EMAIL", email: "recipient@example.invalid", displayName: "本人", sortOrder: 50 },
    ];

    await expect(resolveCcRecipients(entries, { email: "Recipient@example.invalid", displayName: "新人" }, { db: testDb.db }))
      .resolves.toEqual([
        { email: "external@outside.example.invalid", displayName: "外部顾问", source: "FIXED" },
        { email: "current.manager@example.invalid", displayName: "发布时经理", source: "ACCOUNT", userId: manager.id },
      ]);
  });

  it("rejects invalid fixed entries and account entries without a current mailbox", async () => {
    const missing = await account(testDb.db, "M-003", "无邮箱经理", null);
    await expect(resolveCcRecipients([
      { kind: "EMAIL", email: "not-an-email", sortOrder: 1 },
    ], { email: "recipient@example.invalid" }, { db: testDb.db })).rejects.toBeInstanceOf(CcResolutionError);
    await expect(resolveCcRecipients([
      { kind: "USER", userId: missing.id, sortOrder: 1 },
    ], { email: "recipient@example.invalid" }, { db: testDb.db }))
      .rejects.toMatchObject({ code: "ACCOUNT_EMAIL_MISSING" });
  });

  it("uses the parsed account mailbox for whitespace-insensitive recipient removal", async () => {
    const manager = await account(testDb.db, "M-004", "带空白邮箱", " Recipient@example.invalid ");
    await expect(resolveCcRecipients([
      { kind: "USER", userId: manager.id, sortOrder: 1 },
    ], { email: "recipient@example.invalid" }, { db: testDb.db })).resolves.toEqual([]);
  });

  it("bounds a USER CC account-name fallback at the sending boundary", async () => {
    const manager = await account(
      testDb.db,
      "M-LONG-NAME",
      "超".repeat(50_000),
      "long-name@example.invalid",
    );

    const [resolved] = await resolveCcRecipients([
      { kind: "USER", userId: manager.id, sortOrder: 1 },
    ], { email: "recipient@example.invalid" }, { db: testDb.db });

    expect(resolved.displayName).toBe("超".repeat(120));
  });

  it("uses one NFKC, trim and lowercase canonicalization for input, database candidates and late binding", async () => {
    const manager = await account(testDb.db, "M-005", "兼容邮箱", " Manager＠Example.INVALID ");
    await expect(resolveCcInput("manager@example.invalid", { db: testDb.db })).resolves.toEqual({
      kind: "USER", userId: manager.id, displayName: "兼容邮箱",
    });
    await expect(resolveCcRecipients([
      { kind: "USER", userId: manager.id, sortOrder: 1 },
    ], { email: "other@example.invalid" }, { db: testDb.db })).resolves.toEqual([{
      email: "manager@example.invalid",
      displayName: "兼容邮箱",
      source: "ACCOUNT",
      userId: manager.id,
    }]);
  });
});

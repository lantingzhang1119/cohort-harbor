import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createPrismaClient } from "@/lib/db/create-client";
import { createTestDatabase } from "../helpers/test-db";

const hardeningMigration = path.resolve(
  "prisma/migrations/202607210003_password_reset_hardening/migration.sql",
);

describe("password reset hardening migration", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("adds delivery state and a database-enforced fifteen-minute throttle trigger", () => {
    const sql = readFileSync(hardeningMigration, "utf8");
    expect(sql).toMatch(/ADD COLUMN "deliveredAt" DATETIME/);
    expect(sql).toMatch(/ADD COLUMN "deliveryFailedAt" DATETIME/);
    expect(sql).toMatch(/CREATE TRIGGER "PasswordResetToken_throttle_insert"/);
    expect(sql).toContain("PASSWORD_RESET_THROTTLED");
    expect(sql).toMatch(/julianday/);
  });

  it("allows at most three concurrent reservations across independent database clients", async () => {
    const user = await testDb.db.user.create({
      data: {
        employeeNo: "TRIGGER-001",
        name: "并发限流员工",
        email: "trigger@example.invalid",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("CurrentPass123"),
      },
    });
    const clients = Array.from({ length: 4 }, () => createPrismaClient(testDb.databaseUrl));
    const createdAt = new Date("2026-07-21T10:00:00.000Z");
    try {
      const outcomes = await Promise.allSettled(
        clients.map((client, index) =>
          client.passwordResetToken.create({
            data: {
              id: randomUUID(),
              userId: user.id,
              tokenHash: `${index}`.repeat(64),
              requestFingerprint: "f".repeat(64),
              createdAt,
              expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1_000),
            },
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(await testDb.db.passwordResetToken.count()).toBe(3);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it("counts reservations at the exact fifteen-minute boundary but releases them one millisecond later", async () => {
    const user = await testDb.db.user.create({
      data: {
        employeeNo: "TRIGGER-BOUNDARY",
        name: "限流边界员工",
        email: "trigger-boundary@example.invalid",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("CurrentPass123"),
      },
    });
    const fingerprint = "b".repeat(64);
    const windowStart = new Date("2026-07-21T09:45:00.000Z");
    const exactBoundary = new Date("2026-07-21T10:00:00.000Z");
    const outsideWindow = new Date(exactBoundary.getTime() + 1);
    const reservation = (index: number, createdAt: Date) => ({
      id: randomUUID(),
      userId: user.id,
      tokenHash: `${index}`.repeat(64),
      requestFingerprint: fingerprint,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1_000),
    });

    await testDb.db.passwordResetToken.createMany({
      data: [0, 1, 2].map((index) => reservation(index, windowStart)),
    });
    await expect(
      testDb.db.passwordResetToken.create({ data: reservation(3, exactBoundary) }),
    ).rejects.toThrow();
    expect(await testDb.db.passwordResetToken.count()).toBe(3);

    await expect(
      testDb.db.passwordResetToken.create({ data: reservation(4, outsideWindow) }),
    ).resolves.toMatchObject({ createdAt: outsideWindow });
    expect(await testDb.db.passwordResetToken.count()).toBe(4);
  });
});

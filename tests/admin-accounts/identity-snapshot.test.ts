import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, UserSource } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("administrator identity snapshots", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("captures only the stable, non-secret user identity", () => {
    expect(
      snapshotUserIdentity({
        id: "admin-1",
        employeeNo: "ADMIN-001",
        name: "历史管理员",
        email: null,
        role: Role.ADMIN,
      }),
    ).toEqual({
      id: "admin-1",
      employeeNo: "ADMIN-001",
      name: "历史管理员",
      email: null,
      role: Role.ADMIN,
    });
  });

  it("writes an actor snapshot with an actor-linked audit event", async () => {
    const actor = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-AUDIT",
        name: "审计管理员",
        email: "audit@example.test",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });

    const audit = await testDb.db.$transaction((transaction) =>
      writeAuditLog(transaction, {
        actorId: actor.id,
        action: "IDENTITY_SNAPSHOT_TEST",
        result: "SUCCESS",
      }),
    );

    expect(audit.actorSnapshot).toEqual({
      id: actor.id,
      employeeNo: actor.employeeNo,
      name: actor.name,
      role: actor.role,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, UserSource, UserStatus } from "@/generated/prisma/enums";
import {
  InvalidDisplayNameError,
  isReservedDisplayName,
  updateOwnDisplayName,
} from "@/features/auth/real-name";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("administrator real-name policy", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function createUser(role: Role, name: string, employeeNo: string) {
    return testDb.db.user.create({
      data: {
        employeeNo,
        name,
        role,
        sourceType: UserSource.MANUAL,
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword("InitialPass123"),
      },
    });
  }

  it.each([
    "系统管理员",
    " 管理员 ",
    "超级管理员",
    "ADMIN",
    "System Administrator",
  ])("recognizes reserved display name %s after normalization", (name) => {
    expect(isReservedDisplayName(name)).toBe(true);
  });

  it.each(["示例员工", "王小明", "Alice Zhang"])("accepts a plausible real name %s", (name) => {
    expect(isReservedDisplayName(name)).toBe(false);
  });

  it.each([Role.ADMIN, Role.SUPER_ADMIN])(
    "allows a %s to update only its own display name and records an audit snapshot",
    async (role) => {
      const administrator = await createUser(role, "系统管理员", `${role}-SELF`);

      await expect(
        updateOwnDisplayName(
          { actorId: administrator.id, name: "  张   三  " },
          testDb.db,
        ),
      ).resolves.toEqual({ name: "张 三" });

      expect(
        await testDb.db.user.findUniqueOrThrow({ where: { id: administrator.id } }),
      ).toMatchObject({ name: "张 三" });
      expect(await testDb.db.auditLog.findFirstOrThrow()).toMatchObject({
        actorId: administrator.id,
        action: "ADMIN_PROFILE_UPDATED",
        targetType: "USER",
        targetId: administrator.id,
        result: "SUCCESS",
        metadata: { beforeName: "系统管理员", afterName: "张 三" },
      });
    },
  );

  it("rejects employees, reserved values, and implausible names without writing an audit row", async () => {
    const employee = await createUser(Role.EMPLOYEE, "新员工", "EMP-SELF");
    const administrator = await createUser(Role.ADMIN, "系统管理员", "ADMIN-SELF");

    await expect(
      updateOwnDisplayName({ actorId: employee.id, name: "员工自改" }, testDb.db),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const name of ["管理员", "A", "x".repeat(81)]) {
      await expect(
        updateOwnDisplayName({ actorId: administrator.id, name }, testDb.db),
      ).rejects.toBeInstanceOf(InvalidDisplayNameError);
    }
    expect(await testDb.db.auditLog.count()).toBe(0);
  });
});

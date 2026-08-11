import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EmployeeModuleKey, Role, UserSource } from "@/generated/prisma/enums";
import {
  getEnabledEmployeeModules,
  updateEmployeeModules,
} from "@/features/employee-modules/module-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

const allModuleKeys = Object.values(EmployeeModuleKey);

describe("employee module settings service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminId: string;
  let superAdminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass123");
    [adminId, superAdminId, employeeId] = await Promise.all([
      testDb.db.user.create({
        data: {
          employeeNo: "MODULE-ADMIN",
          name: "板块管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash,
        },
      }).then((user) => user.id),
      testDb.db.user.create({
        data: {
          employeeNo: "MODULE-SUPER",
          name: "板块超级管理员",
          role: Role.SUPER_ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash,
        },
      }).then((user) => user.id),
      testDb.db.user.create({
        data: {
          employeeNo: "MODULE-EMPLOYEE",
          name: "板块员工",
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash,
        },
      }).then((user) => user.id),
    ]);
  });

  afterEach(async () => testDb.cleanup());

  it("loads exactly the seven enabled defaults", async () => {
    expect([...await getEnabledEmployeeModules(testDb.db)].sort()).toEqual(
      [...allModuleKeys].sort(),
    );
  });

  it.each(["administrator", "super administrator"])(
    "lets an %s atomically replace the enabled set and records before/after state",
    async (seat) => {
      const actorId = seat === "administrator" ? adminId : superAdminId;
      const enabledKeys = [EmployeeModuleKey.GUIDES, EmployeeModuleKey.RESULTS];

      await updateEmployeeModules(actorId, enabledKeys, testDb.db);

      expect([...await getEnabledEmployeeModules(testDb.db)].sort()).toEqual(
        [...enabledKeys].sort(),
      );
      const rows = await testDb.db.employeeModuleSetting.findMany({
        orderBy: { key: "asc" },
      });
      expect(rows).toHaveLength(7);
      expect(rows.filter((row) => row.enabled).map((row) => row.key).sort()).toEqual(
        [...enabledKeys].sort(),
      );
      expect(rows.every((row) => row.updatedById === actorId)).toBe(true);
      const audit = await testDb.db.auditLog.findFirstOrThrow({
        where: { action: "EMPLOYEE_MODULE_SETTINGS_UPDATE" },
      });
      expect(audit.actorId).toBe(actorId);
      expect(audit.metadata).toMatchObject({
        before: expect.arrayContaining(allModuleKeys),
        after: enabledKeys,
      });
    },
  );

  it("rejects employees and invalid keys without partially changing settings", async () => {
    await expect(
      updateEmployeeModules(employeeId, [EmployeeModuleKey.GUIDES], testDb.db),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateEmployeeModules(adminId, ["UNKNOWN" as EmployeeModuleKey], testDb.db),
    ).rejects.toThrow();
    expect([...await getEnabledEmployeeModules(testDb.db)].sort()).toEqual(
      [...allModuleKeys].sort(),
    );
    expect(await testDb.db.auditLog.count()).toBe(0);
  });

  it("fails closed when the configured rows are incomplete or contain an invalid enum value", async () => {
    await testDb.db.employeeModuleSetting.delete({
      where: { key: EmployeeModuleKey.RETAKE },
    });
    expect([...await getEnabledEmployeeModules(testDb.db)]).toEqual([]);

    await testDb.db.$executeRawUnsafe(
      "INSERT INTO EmployeeModuleSetting (key, enabled, updatedAt) VALUES ('INVALID_KEY', 1, CURRENT_TIMESTAMP)",
    );
    expect([...await getEnabledEmployeeModules(testDb.db)]).toEqual([]);
  });
});

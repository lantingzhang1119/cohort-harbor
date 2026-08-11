import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Role,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  buildEligibleEmployeeWhere,
  isEligibleExamAssignee,
  resolveAssigneeSelection,
} from "@/features/exam-tasks/employee-selection";
import { createTestDatabase } from "../helpers/test-db";

describe("exam task employee selection", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let employees: Array<{ id: string; employeeNo: string }>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("SelectPass!23");
    employees = [];
    const seeds: Array<{ department: string; location: WorkLocation; no: string }> = [
      { department: "研发中心", location: WorkLocation.SHANGHAI, no: "SEL-R1" },
      { department: "研发中心", location: WorkLocation.SHENZHEN, no: "SEL-R2" },
      { department: "行政部", location: WorkLocation.SHANGHAI, no: "SEL-A1" },
    ];
    for (const seed of seeds) {
      const user = await testDb.db.user.create({
        data: {
          employeeNo: seed.no,
          name: `选择员工${employees.length + 1}`,
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash,
          firstDepartment: seed.department,
          workLocation: seed.location,
          status: UserStatus.ACTIVE,
          enabled: true,
        },
      });
      employees.push({ id: user.id, employeeNo: user.employeeNo });
    }
  });

  afterEach(async () => testDb.cleanup());

  it("marks only active enabled employees as eligible", () => {
    expect(
      isEligibleExamAssignee({
        role: Role.EMPLOYEE,
        status: UserStatus.ACTIVE,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isEligibleExamAssignee({
        role: Role.EMPLOYEE,
        status: UserStatus.DEPARTED,
        enabled: true,
      }),
    ).toBe(false);
    expect(
      isEligibleExamAssignee({
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        enabled: true,
      }),
    ).toBe(false);
  });

  it("resolves EXPLICIT ids without cross-page loss semantics", async () => {
    const resolved = await resolveAssigneeSelection(testDb.db, {
      mode: "EXPLICIT",
      userIds: [employees[2]!.id, employees[0]!.id],
    });
    expect(resolved.map((item) => item.id)).toEqual([employees[2]!.id, employees[0]!.id]);
  });

  it("resolves FILTER + excluded IDs across the full filtered set", async () => {
    const resolved = await resolveAssigneeSelection(testDb.db, {
      mode: "FILTER",
      filter: { department: "研发中心" },
      excludedUserIds: [employees[0]!.id],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe(employees[1]!.id);
  });

  it("supports name/employeeNo search and city filter in eligible where", async () => {
    const where = buildEligibleEmployeeWhere({
      query: employees[0]!.employeeNo,
      location: WorkLocation.SHANGHAI,
    });
    const found = await testDb.db.user.findMany({ where });
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(employees[0]!.id);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EmployeeModuleKey,
  FileAssetKind,
  Role,
  SessionViewMode,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  employeeModuleForAsset,
  isKindServedByGenericFileRoute,
  requireEmployeeModule,
} from "@/features/employee-modules/module-guards";
import {
  employeePageDecision,
  getEmployeeNavigationItems,
} from "@/features/employee-modules/module-definitions";
import { createTestDatabase } from "../helpers/test-db";

describe("employee module guards", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let employee: Awaited<ReturnType<typeof testDb.db.user.create>>;
  let administrator: Awaited<ReturnType<typeof testDb.db.user.create>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass123");
    employee = await testDb.db.user.create({
      data: {
        employeeNo: "MODULE-GUARD-EMP",
        name: "权限员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash,
      },
    });
    administrator = await testDb.db.user.create({
      data: {
        employeeNo: "MODULE-GUARD-ADMIN",
        name: "权限管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
      },
    });
  });

  afterEach(async () => testDb.cleanup());

  it("applies a disabled module to employees and administrators in employee view", async () => {
    await testDb.db.employeeModuleSetting.update({
      where: { key: EmployeeModuleKey.EXAM },
      data: { enabled: false },
    });

    for (const user of [employee, administrator]) {
      await expect(requireEmployeeModule(
        { user, viewMode: SessionViewMode.EMPLOYEE },
        EmployeeModuleKey.EXAM,
        testDb.db,
      )).rejects.toMatchObject({
        code: "MODULE_DISABLED",
        status: 403,
        message: "该板块当前未开放",
      });
    }
    await expect(requireEmployeeModule(
      { user: administrator, viewMode: SessionViewMode.ADMIN },
      EmployeeModuleKey.GUIDES,
      testDb.db,
    )).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("returns the user when the requested module is enabled", async () => {
    await expect(requireEmployeeModule(
      { user: employee, viewMode: SessionViewMode.EMPLOYEE },
      EmployeeModuleKey.GUIDES,
      testDb.db,
    )).resolves.toMatchObject({ id: employee.id });
  });

  it("uses one fixed seven-module model for navigation and closed-page decisions", () => {
    const enabled = new Set<EmployeeModuleKey>([EmployeeModuleKey.GUIDES, EmployeeModuleKey.RESULTS]);
    expect(getEmployeeNavigationItems(enabled).map((item) => item.key)).toEqual([
      EmployeeModuleKey.GUIDES,
      EmployeeModuleKey.RESULTS,
    ]);
    for (const key of Object.values(EmployeeModuleKey)) {
      expect(employeePageDecision(enabled, key)).toBe(
        enabled.has(key) ? null : "/employee?notice=module-closed",
      );
    }
  });

  it("maps legacy assets to modules and defaults the generic route to deny new private kinds", () => {
    expect(employeeModuleForAsset(FileAssetKind.GUIDE_IMAGE)).toBe(EmployeeModuleKey.GUIDES);
    expect(employeeModuleForAsset(FileAssetKind.GUIDE_MAP)).toBe(EmployeeModuleKey.GUIDES);
    expect(employeeModuleForAsset(FileAssetKind.PORTAL_IMAGE)).toBe(EmployeeModuleKey.GUIDES);
    expect(employeeModuleForAsset(FileAssetKind.POLICY_PDF)).toBeNull();
    expect(employeeModuleForAsset(FileAssetKind.POLICY_FILE)).toBeNull();
    expect(employeeModuleForAsset(FileAssetKind.POLICY_PREVIEW)).toBeNull();
    expect(employeeModuleForAsset(FileAssetKind.ONBOARDING_MATERIAL)).toBe(EmployeeModuleKey.ONBOARDING_KIT);
    expect(employeeModuleForAsset(FileAssetKind.ONBOARDING_EMAIL_ASSET)).toBeNull();
    expect(isKindServedByGenericFileRoute(FileAssetKind.GUIDE_IMAGE)).toBe(true);
    expect(isKindServedByGenericFileRoute(FileAssetKind.POLICY_PDF)).toBe(false);
    expect(isKindServedByGenericFileRoute(FileAssetKind.ONBOARDING_MATERIAL)).toBe(false);
    expect(isKindServedByGenericFileRoute(FileAssetKind.ONBOARDING_EMAIL_ASSET)).toBe(false);
  });
});

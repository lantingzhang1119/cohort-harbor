import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, UserSource, UserStatus } from "@/generated/prisma/enums";
import { verifyPassword } from "@/features/auth/password";
import { ensureAdmin, seedDatabase } from "../../scripts/seed";
import { createTestDatabase } from "../helpers/test-db";

describe("local database seed", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => testDb.cleanup());

  it("is idempotent and preserves a transferred super administrator identity and password", async () => {
    await seedDatabase(testDb.db, {
      adminUsername: "local-admin",
      adminDisplayName: "本地测试管理员",
      adminPassword: "FirstAdminPass!23",
    });
    await seedDatabase(testDb.db, {
      adminUsername: "local-admin",
      adminDisplayName: "更新后的显示名称",
      adminPassword: "ReplacementPass!45",
    });

    expect(await testDb.db.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
    expect(await testDb.db.user.count({ where: { role: "ADMIN" } })).toBe(0);
    expect(await testDb.db.exam.count()).toBe(1);
    expect(await testDb.db.question.count()).toBe(23);
    expect(await testDb.db.questionBank.count()).toBe(1);
    expect(await testDb.db.questionBankQuestion.count()).toBe(23);
    expect(await testDb.db.questionBank.findFirstOrThrow()).toMatchObject({
      name: "入职学习考试",
      isDefault: true,
      status: "ENABLED",
      source: "LEGACY",
      enabledScore: 100,
      questionCount: 23,
    });
    expect(await testDb.db.cityGuide.count()).toBe(4);
    expect(await testDb.db.systemSetting.count()).toBe(1);
    expect(await testDb.db.employeeModuleSetting.findMany({ orderBy: { key: "asc" } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "GUIDES", enabled: true }),
        expect.objectContaining({ key: "ONBOARDING_KIT", enabled: true }),
        expect.objectContaining({ key: "POLICIES", enabled: true }),
        expect.objectContaining({ key: "EXAM", enabled: true }),
        expect.objectContaining({ key: "RESULTS", enabled: true }),
        expect.objectContaining({ key: "RETAKE", enabled: true }),
        expect.objectContaining({ key: "NOTIFICATIONS", enabled: true }),
      ]));
    expect(await testDb.db.employeeModuleSetting.count()).toBe(7);
    expect(await testDb.db.onboardingMailField.count({ where: { builtIn: true } })).toBe(10);
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
    expect((await testDb.db.systemSetting.findUniqueOrThrow({ where: { id: "default" } })).onboardingMailAutomationEnabled).toBe(false);
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);

    const admin = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "local-admin" } });
    expect(admin.name).toBe("本地测试管理员");
    await expect(verifyPassword("FirstAdminPass!23", admin.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("ReplacementPass!45", admin.passwordHash)).resolves.toBe(false);
  });

  it("preserves administrator module and common-field choices on repeated seed", async () => {
    const options = {
      adminUsername: "local-admin",
      adminDisplayName: "本地测试管理员",
      adminPassword: "FirstAdminPass!23",
    };
    await seedDatabase(testDb.db, options);
    await testDb.db.employeeModuleSetting.update({ where: { key: "EXAM" }, data: { enabled: false } });
    await testDb.db.onboardingMailField.update({ where: { key: "companyName" }, data: { label: "品牌", enabled: false } });
    const bank = await testDb.db.questionBank.findFirstOrThrow();
    const question = await testDb.db.questionBankQuestion.findFirstOrThrow({
      where: { questionBankId: bank.id },
      orderBy: { sequence: "asc" },
    });
    await testDb.db.questionBank.update({ where: { id: bank.id }, data: { name: "管理员自定义题库" } });
    await testDb.db.questionBankQuestion.update({ where: { id: question.id }, data: { prompt: "管理员自定义题干" } });

    await seedDatabase(testDb.db, options);

    expect(await testDb.db.employeeModuleSetting.findUniqueOrThrow({ where: { key: "EXAM" } }))
      .toMatchObject({ enabled: false });
    expect(await testDb.db.onboardingMailField.findUniqueOrThrow({ where: { key: "companyName" } }))
      .toMatchObject({ label: "品牌", enabled: false });
    expect(await testDb.db.onboardingMailTemplate.count()).toBe(0);
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
    expect(await testDb.db.questionBank.findUniqueOrThrow({ where: { id: bank.id } }))
      .toMatchObject({ name: "管理员自定义题库" });
    expect(await testDb.db.questionBankQuestion.findUniqueOrThrow({ where: { id: question.id } }))
      .toMatchObject({ prompt: "管理员自定义题干" });
  });

  it("does not create another super administrator after the configured identity changes", async () => {
    await seedDatabase(testDb.db, {
      adminUsername: "original-admin",
      adminDisplayName: "原超级管理员",
      adminPassword: "FirstAdminPass!23",
    });

    await testDb.db.user.update({
      where: { employeeNo: "original-admin" },
      data: { employeeNo: "transferred-admin", name: "接管后管理员" },
    });

    await seedDatabase(testDb.db, {
      adminUsername: "original-admin",
      adminDisplayName: "配置中的旧管理员",
      adminPassword: "ReplacementPass!45",
    });

    expect(await testDb.db.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
    expect(await testDb.db.user.count({ where: { employeeNo: "original-admin" } })).toBe(0);
    const transferred = await testDb.db.user.findUniqueOrThrow({
      where: { employeeNo: "transferred-admin" },
    });
    expect(transferred.name).toBe("接管后管理员");
    await expect(verifyPassword("FirstAdminPass!23", transferred.passwordHash)).resolves.toBe(true);
  });

  it("requires an explicit flag before replacing an existing administrator password", async () => {
    await seedDatabase(testDb.db, { adminUsername: "local-admin", adminDisplayName: "管理员", adminPassword: "FirstAdminPass!23" });
    await seedDatabase(testDb.db, { adminUsername: "local-admin", adminDisplayName: "管理员", adminPassword: "ResetAdminPass!45", resetAdminPassword: true });
    const admin = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "local-admin" } });
    await expect(verifyPassword("ResetAdminPass!45", admin.passwordHash)).resolves.toBe(true);
  });

  it.each([
    ["OnlyLettersHere", "all-letter"],
    ["123456789012", "all-digit"],
  ])("rejects an %s administrator password", async (adminPassword) => {
    await expect(
      ensureAdmin(testDb.db, {
        adminUsername: "local-admin",
        adminDisplayName: "管理员",
        adminPassword,
      }),
    ).rejects.toThrow("至少 10 位且必须同时包含英文字母和数字");
  });

  it("rejects multiple preexisting super administrators", async () => {
    await testDb.db.user.createMany({
      data: [
        {
          employeeNo: "SUPER-001",
          name: "超级管理员甲",
          role: Role.SUPER_ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: "unused-hash",
        },
        {
          employeeNo: "SUPER-002",
          name: "超级管理员乙",
          role: Role.SUPER_ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: "unused-hash",
        },
      ],
    });

    await expect(
      ensureAdmin(testDb.db, {
        adminUsername: "configured-admin",
        adminDisplayName: "配置管理员",
      }),
    ).rejects.toThrow("数据库中必须恰好存在一个可用的超级管理员");
  });

  it.each([
    { enabled: false, status: UserStatus.ACTIVE, adminArchivedAt: null },
    { enabled: true, status: UserStatus.DISABLED, adminArchivedAt: null },
    { enabled: true, status: UserStatus.ACTIVE, adminArchivedAt: new Date("2026-07-21T00:00:00Z") },
  ])("rejects an invalid preexisting super administrator state", async (state) => {
    await testDb.db.user.create({
      data: {
        employeeNo: "SUPER-INVALID",
        name: "状态异常的超级管理员",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: "unused-hash",
        ...state,
      },
    });

    await expect(
      ensureAdmin(testDb.db, {
        adminUsername: "configured-admin",
        adminDisplayName: "配置管理员",
      }),
    ).rejects.toThrow("数据库中必须恰好存在一个可用的超级管理员");
  });
});

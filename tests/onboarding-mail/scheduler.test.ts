import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import {
  explainWelcomeEligibility,
  type WelcomeEligibilityReason,
} from "@/features/onboarding-mail/eligibility-service";
import {
  enqueueDueWelcomeMail,
  setWelcomeMailAutomationEnabled,
} from "@/features/onboarding-mail/scheduler";
import { createPrismaClient } from "@/lib/db/create-client";
import { createTestDatabase } from "../helpers/test-db";

const localDate = "2026-07-22";
const now = new Date("2026-07-22T04:00:00.000Z");
const basicField = [{
  key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true,
}, {
  key: "companyName", kind: "BUILTIN", label: "公司名称", enabled: true, sortOrder: 2, required: true,
}];

async function fixture(db: PrismaClient, employeeNo = "NEW-001", hiredAt = new Date("2026-07-22T00:00:00.000Z")) {
  const employee = await db.user.create({ data: {
    employeeNo,
    name: `${employeeNo} 姓名`,
    email: `${employeeNo.toLowerCase()}@example.invalid`,
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    status: UserStatus.ACTIVE,
    enabled: true,
    hiredAt,
    passwordHash: "unused",
  } });
  let template = await db.onboardingMailTemplate.findUnique({ where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME } });
  if (!template) template = await db.onboardingMailTemplate.create({ data: {
    kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME,
    name: "欢迎信",
    enabled: true,
    defaultSendTime: "09:00",
  } });
  let revision = await db.onboardingMailTemplateRevision.findFirst({ where: { templateId: template.id } });
  if (!revision) {
    revision = await db.onboardingMailTemplateRevision.create({ data: {
      templateId: template.id,
      revisionNumber: 1,
      senderDisplayName: "人力资源部",
      subject: "{{companyName}}欢迎 {{name}}",
      htmlBody: "<p>欢迎 {{name}}</p>",
      textBody: "欢迎 {{name}}",
      fieldConfig: basicField,
      styleConfig: {},
      publishedBySnapshot: {},
    } });
    await db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
  }
  await db.systemSetting.upsert({
    where: { id: "default" },
    create: { id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: new Date("2026-07-22T07:00:00.000Z") },
    update: { onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: new Date("2026-07-22T07:00:00.000Z") },
  });
  return { employee, template, revision };
}

describe("welcome-mail eligibility and scheduler", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => { await testDb.cleanup(); });

  it("matches both UTC-midnight and server-local parsed hire instants through the Shanghai half-open day", async () => {
    const utcStored = await fixture(testDb.db, "UTC-STYLE", new Date("2026-07-22T00:00:00.000Z"));
    const localStored = await fixture(testDb.db, "NY-STYLE", new Date("2026-07-22T04:00:00.000Z"));
    for (const employee of [utcStored.employee, localStored.employee]) {
      await expect(explainWelcomeEligibility(employee.id, localDate, {
        db: testDb.db, now: () => now, lookbackDays: 1,
      })).resolves.toMatchObject({ eligible: true, reason: null });
    }
  });

  it("returns every stable exclusion reason from the same eligibility function used by scheduling", async () => {
    const { employee, template, revision } = await fixture(testDb.db);
    const check = () => explainWelcomeEligibility(employee.id, localDate, {
      db: testDb.db, now: () => now, lookbackDays: 1,
    });
    const cases: Array<[WelcomeEligibilityReason, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["NO_EMAIL", () => testDb.db.user.update({ where: { id: employee.id }, data: { email: null } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { email: `${employee.employeeNo.toLowerCase()}@example.invalid` } })],
      ["USER_NOT_EMPLOYEE", () => testDb.db.user.update({ where: { id: employee.id }, data: { role: Role.ADMIN } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { role: Role.EMPLOYEE } })],
      ["USER_DISABLED", () => testDb.db.user.update({ where: { id: employee.id }, data: { enabled: false } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { enabled: true } })],
      ["USER_INACTIVE", () => testDb.db.user.update({ where: { id: employee.id }, data: { status: UserStatus.DEPARTED } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { status: UserStatus.ACTIVE } })],
      ["AUTOMATION_OFF", () => testDb.db.systemSetting.update({ where: { id: "default" }, data: { onboardingMailAutomationEnabled: false } }), () => testDb.db.systemSetting.update({ where: { id: "default" }, data: { onboardingMailAutomationEnabled: true } })],
      ["TEMPLATE_DISABLED", () => testDb.db.onboardingMailTemplate.update({ where: { id: template.id }, data: { enabled: false } }), () => testDb.db.onboardingMailTemplate.update({ where: { id: template.id }, data: { enabled: true } })],
      ["MISSING_REQUIRED_FIELD", () => testDb.db.user.update({ where: { id: employee.id }, data: { name: " " } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { name: `${employee.employeeNo} 姓名` } })],
      ["DATE_MISMATCH", () => testDb.db.user.update({ where: { id: employee.id }, data: { hiredAt: new Date("2026-07-23T00:00:00.000Z") } }), () => testDb.db.user.update({ where: { id: employee.id }, data: { hiredAt: new Date("2026-07-22T00:00:00.000Z") } })],
      ["DATE_BEFORE_AUTOMATION_FLOOR", () => testDb.db.systemSetting.update({ where: { id: "default" }, data: { onboardingMailAutomationEnabledAt: new Date("2026-07-23T07:00:00.000Z") } }), () => testDb.db.systemSetting.update({ where: { id: "default" }, data: { onboardingMailAutomationEnabledAt: new Date("2026-07-22T07:00:00.000Z") } })],
    ];
    for (const [reason, apply, restore] of cases) {
      await apply();
      expect(await check()).toMatchObject({ eligible: false, reason });
      await restore();
    }
    expect(await explainWelcomeEligibility(employee.id, "2026-07-20", {
      db: testDb.db, now: () => now, lookbackDays: 1,
    })).toMatchObject({ eligible: false, reason: "DATE_BEFORE_AUTOMATION_FLOOR" });
    await testDb.db.systemSetting.update({ where: { id: "default" }, data: { onboardingMailAutomationEnabledAt: new Date("2026-07-01T00:00:00.000Z") } });
    expect(await explainWelcomeEligibility(employee.id, "2026-07-20", {
      db: testDb.db, now: () => now, lookbackDays: 1,
    })).toMatchObject({ eligible: false, reason: "LOOKBACK_EXCEEDED" });
    await testDb.db.onboardingMailDelivery.create({ data: {
      status: OnboardingMailDeliveryStatus.SENT,
      source: OnboardingMailDeliverySource.AUTOMATIC,
      idempotencyKey: `welcome:${employee.id}:${localDate}`,
      recipientId: employee.id,
      recipientEmailSnapshot: employee.email!, recipientSnapshot: {},
      templateRevisionId: revision.id, templateSnapshot: {}, fieldSummary: {}, ccSnapshot: [], attachmentSummary: [],
      scheduledLocalDate: localDate, scheduledAt: now, sentAt: now,
    } });
    expect(await check()).toMatchObject({ eligible: false, reason: "ALREADY_SENT" });
  });

  it("does not enqueue an administrator even when hire date, state, and email otherwise match", async () => {
    const { employee } = await fixture(testDb.db, "ADMIN-NOT-RECIPIENT");
    await testDb.db.user.update({ where: { id: employee.id }, data: { role: Role.ADMIN } });

    const summary = await enqueueDueWelcomeMail(localDate, undefined, {
      db: testDb.db,
      now: () => now,
      lookbackDays: 1,
    });

    expect(summary).toMatchObject({ matched: 1, eligible: 0, enqueued: 0, excluded: 1 });
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
  });

  it("keeps the first enable timestamp across disable/re-enable and compares its Shanghai calendar date", async () => {
    await fixture(testDb.db);
    await testDb.db.systemSetting.update({ where: { id: "default" }, data: {
      onboardingMailAutomationEnabled: false, onboardingMailAutomationEnabledAt: null,
    } });
    const first = new Date("2026-07-22T07:00:00.000Z");
    await setWelcomeMailAutomationEnabled(true, "admin-1", { db: testDb.db, now: () => first });
    await setWelcomeMailAutomationEnabled(false, "admin-1", { db: testDb.db, now: () => new Date("2026-07-23T00:00:00.000Z") });
    await setWelcomeMailAutomationEnabled(true, "admin-2", { db: testDb.db, now: () => new Date("2026-07-24T00:00:00.000Z") });
    expect(await testDb.db.systemSetting.findUniqueOrThrow({ where: { id: "default" } })).toMatchObject({
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: first,
      onboardingMailAutomationEnabledById: "admin-1",
    });
  });

  it("enforces the 0..7 lookback bound at the eligibility service boundary", async () => {
    const { employee } = await fixture(testDb.db, "LOOKBACK-BOUND");
    await expect(explainWelcomeEligibility(employee.id, localDate, {
      db: testDb.db, now: () => now, lookbackDays: 0,
    })).resolves.toMatchObject({ eligible: true });
    await expect(explainWelcomeEligibility(employee.id, localDate, {
      db: testDb.db, now: () => now, lookbackDays: 7,
    })).resolves.toMatchObject({ eligible: true });
    await expect(explainWelcomeEligibility(employee.id, localDate, {
      db: testDb.db, now: () => now, lookbackDays: 8,
    })).rejects.toThrow("lookbackDays");
  });

  it("schedules 09:00 Shanghai, snapshots immutable content, and stays idempotent under concurrent enqueue", async () => {
    const { employee } = await fixture(testDb.db);
    const second = createPrismaClient(testDb.databaseUrl);
    try {
      const summaries = await Promise.all([
        enqueueDueWelcomeMail(localDate, undefined, { db: testDb.db, now: () => now, lookbackDays: 1 }),
        enqueueDueWelcomeMail(localDate, undefined, { db: second, now: () => now, lookbackDays: 1 }),
      ]);
      expect(summaries.reduce((sum, item) => sum + item.enqueued, 0)).toBe(1);
      const delivery = await testDb.db.onboardingMailDelivery.findFirstOrThrow();
      expect(delivery).toMatchObject({
        source: OnboardingMailDeliverySource.AUTOMATIC,
        idempotencyKey: `welcome:${employee.id}:${localDate}`,
        scheduledLocalDate: localDate,
        scheduledAt: new Date("2026-07-22T01:00:00.000Z"),
        recipientEmailSnapshot: employee.email,
      });
      expect(delivery.templateSnapshot).toMatchObject({ subject: "CohortHarbor欢迎 NEW-001 姓名" });
    } finally {
      await second.$disconnect();
    }
  });

  it("requires explicit confirmation above the bulk threshold and renders a separate message for each employee", async () => {
    const first = await fixture(testDb.db, "BULK-1");
    const second = await fixture(testDb.db, "BULK-2");
    await expect(enqueueDueWelcomeMail(localDate, undefined, {
      db: testDb.db, now: () => now, lookbackDays: 1, bulkConfirmThreshold: 1,
    })).rejects.toMatchObject({ code: "BULK_CONFIRMATION_REQUIRED", count: 2 });
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
    await enqueueDueWelcomeMail(localDate, undefined, {
      db: testDb.db, now: () => now, lookbackDays: 1, bulkConfirmThreshold: 1, confirmBulk: true,
    });
    const deliveries = await testDb.db.onboardingMailDelivery.findMany({ orderBy: { recipientEmailSnapshot: "asc" } });
    expect(deliveries).toHaveLength(2);
    const subjects = deliveries.map((delivery) => (delivery.templateSnapshot as { subject: string }).subject);
    expect(subjects).toContain(`CohortHarbor欢迎 ${first.employee.employeeNo} 姓名`);
    expect(subjects).toContain(`CohortHarbor欢迎 ${second.employee.employeeNo} 姓名`);
  });

  it("never backfills historical hires merely because --date was supplied", async () => {
    await fixture(testDb.db, "HISTORICAL", new Date("2025-01-10T00:00:00.000Z"));
    await testDb.db.user.createMany({ data: Array.from({ length: 318 }, (_, index) => ({
      employeeNo: `HISTORICAL-${index}`,
      name: `历史员工 ${index}`,
      email: `historical-${index}@example.invalid`,
      role: Role.EMPLOYEE,
      sourceType: UserSource.EXCEL,
      status: UserStatus.ACTIVE,
      enabled: true,
      hiredAt: new Date("2025-01-10T00:00:00.000Z"),
      passwordHash: "unused",
    })) });
    const summary = await enqueueDueWelcomeMail("2025-01-10", undefined, {
      db: testDb.db, now: () => now, lookbackDays: 1, confirmBulk: true,
    });
    expect(summary.enqueued).toBe(0);
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
    expect(await testDb.db.user.count({ where: { hiredAt: new Date("2025-01-10T00:00:00.000Z") } })).toBe(319);
  });
});

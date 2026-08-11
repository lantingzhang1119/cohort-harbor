import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import { updateEmployee } from "@/features/employees/employee-service";
import type { SmtpOutcome } from "@/features/mail/smtp-transport";
import {
  createWelcomeDelivery,
  resolveUnknownDelivery,
  type DeliveryTransport,
} from "@/features/onboarding-mail/delivery-service";
import { runOnboardingMailCycle } from "@/features/onboarding-mail/outbox-worker";
import { enqueueDueWelcomeMail } from "@/features/onboarding-mail/scheduler";
import { createTestDatabase } from "../helpers/test-db";

const oldDate = "2026-07-22";
const newDate = "2026-07-23";
const oldHire = new Date("2026-07-22T00:00:00.000Z");
const newHire = new Date("2026-07-23T00:00:00.000Z");
const now = new Date("2026-07-23T04:00:00.000Z");
const lease = {
  leaseDurationMs: 30_000,
  transportHardTimeoutMs: 20_000,
  safetyMarginMs: 10_000,
};
const accepted: SmtpOutcome = {
  kind: "accepted",
  providerMessageId: "provider-unknown-isolation",
  responseSummary: "250 queued",
  protocolStage: "POST_DATA",
  ccRejectedCount: 0,
};

async function fixture(db: PrismaClient) {
  const actor = await db.user.create({ data: {
    employeeNo: "UNKNOWN-ADMIN",
    name: "管理员",
    role: Role.ADMIN,
    sourceType: UserSource.MANUAL,
    passwordHash: "unused",
  } });
  const employee = await db.user.create({ data: {
    employeeNo: "UNKNOWN-EMP",
    name: "结果待确认员工",
    email: "unknown@example.invalid",
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    status: UserStatus.ACTIVE,
    enabled: true,
    hiredAt: oldHire,
    workLocation: WorkLocation.SHANGHAI,
    passwordHash: "unused",
  } });
  const template = await db.onboardingMailTemplate.create({ data: {
    kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME,
    name: "欢迎信",
    enabled: true,
    defaultSendTime: "09:00",
  } });
  const revision = await db.onboardingMailTemplateRevision.create({ data: {
    templateId: template.id,
    revisionNumber: 1,
    senderDisplayName: "HR",
    subject: "欢迎 {{name}}",
    htmlBody: "<p>欢迎 {{name}}</p>",
    textBody: "欢迎 {{name}}",
    fieldConfig: [{
      key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true,
    }],
    styleConfig: {},
    publishedBySnapshot: {},
  } });
  await db.onboardingMailTemplate.update({
    where: { id: template.id }, data: { currentRevisionId: revision.id },
  });
  await db.systemSetting.create({ data: {
    id: "default",
    onboardingMailAutomationEnabled: true,
    onboardingMailAutomationEnabledAt: new Date("2026-07-21T16:00:00.000Z"),
  } });
  const unknown = await createWelcomeDelivery({
    source: OnboardingMailDeliverySource.AUTOMATIC,
    recipientId: employee.id,
    templateRevisionId: revision.id,
    scheduledLocalDate: oldDate,
    scheduledAt: new Date("2026-07-22T01:00:00.000Z"),
  }, { db, now: () => oldHire });
  await db.onboardingMailDelivery.update({
    where: { id: unknown.id },
    data: {
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      dispatchedAt: new Date("2026-07-22T01:00:00.000Z"),
      failureCode: "SMTP_AMBIGUOUS",
    },
  });
  await updateEmployee(db, employee.id, { hiredAt: newHire }, actor.id);
  return { employee, revision, unknown };
}

async function runWorker(db: PrismaClient, transport: DeliveryTransport) {
  return runOnboardingMailCycle({
    db,
    transport,
    workerId: "unknown-isolation-worker",
    now: () => now,
    runtimeEnabled: true,
    localDate: newDate,
    lookbackDays: 1,
    batchSize: 10,
    ...lease,
  });
}

describe("employee-level UNKNOWN welcome-mail isolation", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => { await testDb.cleanup(); });

  it("blocks ordinary automatic enqueue and worker send after the hire date changes", async () => {
    const { employee, unknown } = await fixture(testDb.db);
    const enqueue = await enqueueDueWelcomeMail(newDate, undefined, {
      db: testDb.db, now: () => now, lookbackDays: 1,
    });
    expect(enqueue.enqueued).toBe(0);

    const send = vi.fn(async (): Promise<SmtpOutcome> => accepted);
    const cycle = await runWorker(testDb.db, { send });
    expect(cycle).toMatchObject({ enqueued: 0, claimed: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findMany({ where: { recipientId: employee.id } })).toEqual([
      expect.objectContaining({
        id: unknown.id,
        source: OnboardingMailDeliverySource.AUTOMATIC,
        status: OnboardingMailDeliveryStatus.UNKNOWN,
        scheduledLocalDate: oldDate,
      }),
    ]);
  });

  it("cancels a pre-existing ordinary automatic row before dispatch while UNKNOWN remains unresolved", async () => {
    const { employee, revision, unknown } = await fixture(testDb.db);
    const bypass = await createWelcomeDelivery({
      source: OnboardingMailDeliverySource.AUTOMATIC,
      recipientId: employee.id,
      templateRevisionId: revision.id,
      scheduledLocalDate: newDate,
      scheduledAt: new Date("2026-07-23T01:00:00.000Z"),
    }, { db: testDb.db, now: () => now });
    const send = vi.fn(async (): Promise<SmtpOutcome> => accepted);

    const cycle = await runWorker(testDb.db, { send });

    expect(cycle).toMatchObject({ enqueued: 0, claimed: 1, cancelled: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      unknownResolution: null,
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: bypass.id } })).toMatchObject({
      source: OnboardingMailDeliverySource.AUTOMATIC,
      status: OnboardingMailDeliveryStatus.CANCELLED,
      failureCode: "ALREADY_SENT",
      dispatchedAt: null,
    });
  });

  it("keeps blocking automatic enqueue after UNKNOWN is confirmed delivered", async () => {
    const { employee, unknown } = await fixture(testDb.db);
    await resolveUnknownDelivery(unknown.id, {
      resolution: "CONFIRMED_DELIVERED", resolverId: null, note: "已确认收到",
    }, { db: testDb.db, now: () => now });
    const send = vi.fn(async (): Promise<SmtpOutcome> => accepted);

    const cycle = await runWorker(testDb.db, { send });

    expect(cycle).toMatchObject({ enqueued: 0, claimed: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findMany({ where: { recipientId: employee.id } })).toEqual([
      expect.objectContaining({
        id: unknown.id,
        status: OnboardingMailDeliveryStatus.UNKNOWN,
        unknownResolution: "CONFIRMED_DELIVERED",
      }),
    ]);
  });

  it("sends confirmed failure only through the linked RESEND and never creates a parallel automatic row", async () => {
    const { employee, unknown } = await fixture(testDb.db);
    const resolution = await resolveUnknownDelivery(unknown.id, {
      resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "确认未收到",
    }, { db: testDb.db, now: () => now });
    const send = vi.fn(async (): Promise<SmtpOutcome> => accepted);

    const cycle = await runWorker(testDb.db, { send });

    expect(cycle).toMatchObject({ enqueued: 0, claimed: 1, sent: 1, cancelled: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await testDb.db.onboardingMailDelivery.findMany({
      where: { recipientId: employee.id }, orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: unknown.id,
      source: OnboardingMailDeliverySource.AUTOMATIC,
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      unknownResolution: "CONFIRMED_FAILED_RESEND",
    });
    expect(rows[1]).toMatchObject({
      id: resolution.resendDeliveryId,
      source: OnboardingMailDeliverySource.RESEND,
      status: OnboardingMailDeliveryStatus.SENT,
      resendOfId: unknown.id,
      idempotencyKey: null,
    });
    expect(rows.some((row) => row.source === OnboardingMailDeliverySource.AUTOMATIC && row.scheduledLocalDate === newDate)).toBe(false);
  });
});

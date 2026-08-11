import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import {
  claimDueDeliveries,
  createWelcomeDelivery,
  releaseUndispatchedDeliveryClaims,
  sanitizeMailErrorSummary,
  UnknownResolutionConflictError,
  processDelivery,
  resolveUnknownDelivery,
} from "@/features/onboarding-mail/delivery-service";
import type { SmtpOutcome } from "@/features/mail/smtp-transport";
import { createTestDatabase } from "../helpers/test-db";

const localDate = "2026-07-22";
const now = new Date("2026-07-22T01:00:00.000Z");

async function fixture(
  db: PrismaClient,
  source: OnboardingMailDeliverySource = OnboardingMailDeliverySource.AUTOMATIC,
) {
  const employee = await db.user.create({ data: {
    employeeNo: `EMP-${Math.random()}`,
    name: "新员工",
    email: `employee-${Math.random()}@example.invalid`,
    role: Role.EMPLOYEE,
    sourceType: UserSource.MANUAL,
    status: UserStatus.ACTIVE,
    enabled: true,
    hiredAt: new Date("2026-07-22T00:00:00.000Z"),
    passwordHash: "unused",
  } });
  const template = await db.onboardingMailTemplate.upsert({
    where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
    create: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "欢迎信", enabled: true },
    update: { enabled: true },
  });
  let revision = await db.onboardingMailTemplateRevision.findFirst({ where: { templateId: template.id } });
  if (!revision) revision = await db.onboardingMailTemplateRevision.create({ data: {
    templateId: template.id,
    revisionNumber: 1,
    senderDisplayName: "人力资源部",
    subject: "{{companyName}}欢迎 {{name}}",
    htmlBody: "<p>{{companyName}}欢迎 {{name}}</p>",
    textBody: "{{companyName}}欢迎 {{name}}",
    fieldConfig: [
      { key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true },
      { key: "companyName", kind: "BUILTIN", label: "公司名称", enabled: true, sortOrder: 2, required: true },
    ],
    styleConfig: {}, publishedBySnapshot: {},
  } });
  await db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
  await db.systemSetting.upsert({
    where: { id: "default" },
    create: { id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: new Date("2026-07-22T00:00:00.000Z") },
    update: { onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: new Date("2026-07-22T00:00:00.000Z") },
  });
  const delivery = await createWelcomeDelivery({
    source,
    recipientId: employee.id,
    templateRevisionId: revision.id,
    scheduledLocalDate: source === OnboardingMailDeliverySource.AUTOMATIC ? localDate : null,
    scheduledAt: now,
  }, { db, now: () => now });
  return { employee, template, revision, delivery };
}

const lease = { leaseDurationMs: 30_000, transportHardTimeoutMs: 20_000, safetyMarginMs: 10_000 };
const accepted: SmtpOutcome = {
  kind: "accepted", providerMessageId: "provider-1", responseSummary: "250 queued", protocolStage: "POST_DATA", ccRejectedCount: 0,
};

describe("durable welcome-mail delivery", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => { await testDb.cleanup(); });

  it("uses nullable idempotency only for automatic mail; manual, test and resend always stay null", async () => {
    const automatic = await fixture(testDb.db);
    expect(automatic.delivery.idempotencyKey).toBe(`welcome:${automatic.employee.id}:${localDate}`);
    for (const source of [OnboardingMailDeliverySource.MANUAL, OnboardingMailDeliverySource.TEST, OnboardingMailDeliverySource.RESEND]) {
      const item = await fixture(testDb.db, source);
      expect(item.delivery.idempotencyKey).toBeNull();
    }
  });

  it.each([
    ['mail failed {"password":"multi word secret","token":"api-token-value"}', ["multi word secret", "api-token-value"]],
    ["SMTP_PASSWORD=hunter2 AUTH_TOKEN=token-value", ["hunter2", "token-value"]],
    ["smtp://worker:url-password@mail.example.invalid disconnected", ["url-password"]],
    ["Authorization: Bearer provider-access-token", ["provider-access-token"]],
    ["password = very secret words", ["very secret words"]],
  ])("redacts bounded operational error details from %s", (message, secrets) => {
    const summary = sanitizeMailErrorSummary(new Error(`${message} ${"x".repeat(600)}`));
    expect(summary.length).toBeLessThanOrEqual(500);
    for (const secret of secrets) expect(summary).not.toContain(secret);
    expect(summary).toContain("[redacted]");
  });

  it("gives two workers disjoint claims and validates lease duration against transport timeout plus margin", async () => {
    const first = await fixture(testDb.db);
    const second = await fixture(testDb.db);
    const [left, right] = await Promise.all([
      claimDueDeliveries("worker-a", now, { db: testDb.db, batchSize: 1, ...lease }),
      claimDueDeliveries("worker-b", now, { db: testDb.db, batchSize: 1, ...lease }),
    ]);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(new Set([left[0].id, right[0].id])).toEqual(new Set([first.delivery.id, second.delivery.id]));
    await expect(claimDueDeliveries("bad", now, {
      db: testDb.db, batchSize: 1, leaseDurationMs: 29_999, transportHardTimeoutMs: 20_000, safetyMarginMs: 10_000,
    })).rejects.toThrow("租约");
  });

  it("recovers expired pre-dispatch work to PENDING but quarantines post-dispatch work as UNKNOWN", async () => {
    const before = await fixture(testDb.db);
    const after = await fixture(testDb.db);
    const expired = new Date(now.getTime() - 1);
    await testDb.db.onboardingMailDelivery.update({ where: { id: before.delivery.id }, data: {
      status: OnboardingMailDeliveryStatus.SENDING, workerId: "dead", leaseExpiresAt: expired, leaseGeneration: 1,
    } });
    await testDb.db.onboardingMailDelivery.update({ where: { id: after.delivery.id }, data: {
      status: OnboardingMailDeliveryStatus.SENDING, workerId: "dead", leaseExpiresAt: expired,
      leaseGeneration: 1, dispatchedAt: new Date(now.getTime() - 500),
    } });

    const claimed = await claimDueDeliveries("recovery", now, { db: testDb.db, batchSize: 10, ...lease });
    expect(claimed.map((item) => item.id)).toContain(before.delivery.id);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: after.delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      retryable: false,
      failureCode: "LEASE_EXPIRED_AFTER_DISPATCH",
    });
  });

  it("does not spend SMTP retry budget while repeatedly recovering expired pre-dispatch claims", async () => {
    const { delivery } = await fixture(testDb.db);
    const firstRecoveryAt = new Date(now.getTime() + lease.leaseDurationMs + 1);
    const secondRecoveryAt = new Date(firstRecoveryAt.getTime() + lease.leaseDurationMs + 1);

    const firstClaim = await claimDueDeliveries("crashed-before-data-1", now, {
      db: testDb.db,
      batchSize: 1,
      ...lease,
    });
    expect(firstClaim[0].attemptCount).toBe(1);
    const secondClaim = await claimDueDeliveries("crashed-before-data-2", firstRecoveryAt, {
      db: testDb.db,
      batchSize: 1,
      ...lease,
    });
    expect(secondClaim[0].attemptCount).toBe(1);
    const thirdClaim = await claimDueDeliveries("real-smtp-worker", secondRecoveryAt, {
      db: testDb.db,
      batchSize: 1,
      ...lease,
    });
    expect(thirdClaim[0].attemptCount).toBe(1);

    await processDelivery(delivery.id, "real-smtp-worker", {
      db: testDb.db,
      transport: { send: async () => ({
        kind: "definite-retryable",
        failureCode: "SMTP_451",
        errorSummary: "451 retry later",
        protocolStage: "ENVELOPE",
      }) },
      now: () => secondRecoveryAt,
      retryLimit: 2,
      retryBaseMs: 1_000,
    });

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.FAILED,
      attemptCount: 1,
      retryable: true,
      failureCode: "SMTP_451",
      nextRetryAt: new Date(secondRecoveryAt.getTime() + 1_000),
    });
  });

  it("never underflows a malformed zero attempt count while recovering or releasing pre-dispatch work", async () => {
    const recovery = await fixture(testDb.db);
    const release = await fixture(testDb.db);
    const expired = new Date(now.getTime() - 1);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: recovery.delivery.id },
      data: {
        status: OnboardingMailDeliveryStatus.SENDING,
        workerId: "malformed-recovery-worker",
        leaseExpiresAt: expired,
        leaseGeneration: 1,
        attemptCount: 0,
        scheduledAt: new Date(now.getTime() + 60_000),
      },
    });
    await testDb.db.onboardingMailDelivery.update({
      where: { id: release.delivery.id },
      data: {
        status: OnboardingMailDeliveryStatus.SENDING,
        workerId: "malformed-release-worker",
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        leaseGeneration: 2,
        attemptCount: 0,
      },
    });

    await expect(claimDueDeliveries("recovery-observer", now, {
      db: testDb.db,
      batchSize: 1,
      ...lease,
    })).resolves.toHaveLength(0);
    await expect(releaseUndispatchedDeliveryClaims("malformed-release-worker", [{
      id: release.delivery.id,
      leaseGeneration: 2,
    }], { db: testDb.db })).resolves.toBe(1);

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: recovery.delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.PENDING,
      attemptCount: 0,
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: release.delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.PENDING,
      attemptCount: 0,
    });
  });

  it.each([
    [accepted, OnboardingMailDeliveryStatus.SENT, false],
    [{ kind: "definite-retryable", failureCode: "SMTP_451", errorSummary: "451 rejected [redacted-email]", protocolStage: "ENVELOPE" } satisfies SmtpOutcome, OnboardingMailDeliveryStatus.FAILED, true],
    [{ kind: "definite-terminal", failureCode: "SMTP_550", errorSummary: "550 rejected [redacted-email]", protocolStage: "ENVELOPE" } satisfies SmtpOutcome, OnboardingMailDeliveryStatus.FAILED, false],
    [{ kind: "ambiguous", failureCode: "SMTP_AMBIGUOUS", errorSummary: "connection lost", protocolStage: "DATA" } satisfies SmtpOutcome, OnboardingMailDeliveryStatus.UNKNOWN, false],
  ])("maps transport outcome %# without leaking secrets", async (outcome, status, retryable) => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async () => outcome) };
    await processDelivery(delivery.id, "worker", {
      db: testDb.db, transport, now: () => now, retryLimit: 3, retryBaseMs: 1_000,
    });
    const stored = await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored.status).toBe(status);
    expect(stored.retryable).toBe(retryable);
    expect(stored.responseSummary).toContain(`protocolStage=${outcome.protocolStage}`);
    expect(JSON.stringify(stored)).not.toContain("smtp-secret");
    if (status === OnboardingMailDeliveryStatus.SENT) {
      expect(stored.sentAt).toEqual(now);
      expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ subject: "CohortHarbor欢迎 新员工" }));
    }
    if (retryable) {
      expect(stored.nextRetryAt).toEqual(new Date(now.getTime() + 1_000));
      expect(stored.dispatchedAt).toBeNull();
    }
  });

  it("rechecks eligibility after claim and cancels without SMTP when the account changed", async () => {
    const { delivery, employee } = await fixture(testDb.db);
    await claimDueDeliveries("worker", now, { db: testDb.db, batchSize: 1, ...lease });
    await testDb.db.user.update({ where: { id: employee.id }, data: { enabled: false } });
    const transport = { send: vi.fn(async () => accepted) };
    await processDelivery(delivery.id, "worker", { db: testDb.db, transport, now: () => now });
    expect(transport.send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.CANCELLED,
      failureCode: "USER_DISABLED",
      dispatchedAt: null,
    });
  });

  it.each([
    {
      label: "recipient is no longer an employee",
      update: { role: Role.ADMIN },
      failureCode: "USER_NOT_EMPLOYEE",
    },
    {
      label: "recipient email changed after the delivery was queued",
      update: { email: "changed-recipient@example.invalid" },
      failureCode: "RECIPIENT_EMAIL_CHANGED",
    },
  ])("cancels a manual delivery before SMTP when $label", async ({ update, failureCode }) => {
    const { delivery, employee } = await fixture(testDb.db, OnboardingMailDeliverySource.MANUAL);
    await claimDueDeliveries("manual-recipient-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    await testDb.db.user.update({ where: { id: employee.id }, data: update });
    const transport = { send: vi.fn(async () => accepted) };

    await expect(processDelivery(delivery.id, "manual-recipient-worker", {
      db: testDb.db,
      transport,
      now: () => now,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.CANCELLED });

    expect(transport.send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.CANCELLED,
      failureCode,
      dispatchedAt: null,
    });
  });

  it.each([
    {
      label: "email",
      update: { email: "raced-recipient@example.invalid" },
      failureCode: "RECIPIENT_EMAIL_CHANGED",
    },
    {
      label: "role",
      update: { role: Role.ADMIN },
      failureCode: "USER_NOT_EMPLOYEE",
    },
    {
      label: "enabled state",
      update: { enabled: false },
      failureCode: "USER_DISABLED",
    },
    {
      label: "employment status",
      update: { status: UserStatus.DEPARTED },
      failureCode: "USER_INACTIVE",
    },
  ])("atomically blocks SMTP when recipient $label changes at the dispatch boundary", async ({ update, failureCode }) => {
    const { delivery, employee } = await fixture(testDb.db, OnboardingMailDeliverySource.MANUAL);
    await claimDueDeliveries("dispatch-boundary-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const realDelegate = testDb.db.onboardingMailDelivery;
    let injected = false;
    const racingDelegate = new Proxy(realDelegate, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: { data?: { dispatchedAt?: Date | string | null } }) => {
            if (!injected && args.data?.dispatchedAt) {
              injected = true;
              await testDb.db.user.update({
                where: { id: employee.id },
                data: update as Prisma.UserUpdateInput,
              });
            }
            return realDelegate.updateMany(args as Parameters<typeof realDelegate.updateMany>[0]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testDb.db, {
      get(target, property) {
        if (property === "onboardingMailDelivery") return racingDelegate;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const transport = { send: vi.fn(async () => accepted) };

    await expect(processDelivery(delivery.id, "dispatch-boundary-worker", {
      db,
      transport,
      now: () => now,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.CANCELLED });

    expect(injected).toBe(true);
    expect(transport.send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.CANCELLED,
      failureCode,
      dispatchedAt: null,
    });
  });

  it("rejects an overlong legacy CC display name before SMTP dispatch", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id },
      data: {
        ccSnapshot: [{ email: "manager@example.invalid", displayName: "经".repeat(121) }],
      },
    });
    await claimDueDeliveries("legacy-cc-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async () => accepted) };

    await expect(processDelivery(delivery.id, "legacy-cc-worker", {
      db: testDb.db,
      transport,
      now: () => now,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.SKIPPED });

    expect(transport.send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.SKIPPED,
      failureCode: "LOCAL_VALIDATION_FAILED",
      dispatchedAt: null,
    });
  });

  it.each([
    ["senderDisplayName", "发".repeat(121)],
    ["subject", "主".repeat(501)],
    ["subject", "欢迎\r\nBcc: attacker@example.invalid"],
    ["html", "文".repeat(1_000_001)],
    ["text", "文".repeat(1_000_001)],
  ] as const)("rejects an invalid legacy %s snapshot before SMTP dispatch", async (field, value) => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id },
      data: {
        templateSnapshot: {
          ...(delivery.templateSnapshot as Prisma.JsonObject),
          [field]: value,
        } as Prisma.InputJsonObject,
      },
    });
    await claimDueDeliveries(`legacy-${field}-worker`, now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async () => accepted) };

    await expect(processDelivery(delivery.id, `legacy-${field}-worker`, {
      db: testDb.db,
      transport,
      now: () => now,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.SKIPPED });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("rejects more than 100 frozen CC recipients before SMTP dispatch", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id },
      data: {
        ccSnapshot: Array.from({ length: 101 }, (_, index) => ({
          email: `manager-${index}@example.invalid`,
          displayName: `经理${index}`,
        })),
      },
    });
    await claimDueDeliveries("legacy-cc-count-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async () => accepted) };

    await expect(processDelivery(delivery.id, "legacy-cc-count-worker", {
      db: testDb.db,
      transport,
      now: () => now,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.SKIPPED });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("applies exponential retry scheduling and stops automatically at the retry cap", async () => {
    const { delivery } = await fixture(testDb.db);
    const rejection: SmtpOutcome = {
      kind: "definite-retryable", failureCode: "SMTP_451", errorSummary: "451 retry", protocolStage: "ENVELOPE",
    };
    await claimDueDeliveries("worker-1", now, { db: testDb.db, batchSize: 1, ...lease });
    await processDelivery(delivery.id, "worker-1", {
      db: testDb.db, transport: { send: async () => rejection }, now: () => now, retryLimit: 2, retryBaseMs: 1_000,
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      attemptCount: 1, retryable: true, nextRetryAt: new Date(now.getTime() + 1_000),
    });
    const retryNow = new Date(now.getTime() + 1_000);
    await claimDueDeliveries("worker-2", retryNow, { db: testDb.db, batchSize: 1, ...lease });
    await processDelivery(delivery.id, "worker-2", {
      db: testDb.db, transport: { send: async () => rejection }, now: () => retryNow, retryLimit: 2, retryBaseMs: 1_000,
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.FAILED, attemptCount: 2, retryable: false, nextRetryAt: null,
    });
  });

  it.each(["SMTP_TRANSPORT_POISONED", "SMTP_TRANSPORT_BUSY"] as const)(
    "does not consume a delivery attempt when the transport returns %s before DATA",
    async (failureCode) => {
      const { delivery } = await fixture(testDb.db);
      let cycleNow = now;
      const transport = {
        send: vi.fn(async (): Promise<SmtpOutcome> => ({
          kind: "definite-retryable",
          failureCode,
          errorSummary: "SMTP transport temporarily unavailable",
          protocolStage: "PRE_DATA",
        })),
      };

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const claimed = await claimDueDeliveries(`pre-data-worker-${cycle}`, cycleNow, {
          db: testDb.db,
          batchSize: 1,
          ...lease,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0].attemptCount).toBe(1);

        await expect(processDelivery(delivery.id, `pre-data-worker-${cycle}`, {
          db: testDb.db,
          transport,
          now: () => cycleNow,
          retryLimit: 1,
          retryBaseMs: 1_000,
        })).resolves.toMatchObject({
          status: OnboardingMailDeliveryStatus.FAILED,
          outcome: { failureCode, protocolStage: "PRE_DATA" },
        });

        const stored = await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
        expect(stored).toMatchObject({
          status: OnboardingMailDeliveryStatus.FAILED,
          attemptCount: 0,
          retryable: true,
          failureCode,
          dispatchedAt: null,
        });
        expect(stored.nextRetryAt).toEqual(new Date(cycleNow.getTime() + 1_000));
        cycleNow = stored.nextRetryAt!;
      }

      expect(transport.send).toHaveBeenCalledTimes(3);
    },
  );

  it("never underflows a malformed zero attempt count on an unattempted transport result", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: OnboardingMailDeliveryStatus.SENDING,
        workerId: "malformed-pre-data-worker",
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        leaseGeneration: 1,
        attemptCount: 0,
      },
    });

    await expect(processDelivery(delivery.id, "malformed-pre-data-worker", {
      db: testDb.db,
      transport: { send: async () => ({
        kind: "definite-retryable",
        failureCode: "SMTP_TRANSPORT_BUSY",
        errorSummary: "transport busy",
        protocolStage: "PRE_DATA",
      }) },
      now: () => now,
      retryLimit: 1,
      retryBaseMs: 1_000,
    })).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.FAILED });

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.FAILED,
      attemptCount: 0,
      retryable: true,
      failureCode: "SMTP_TRANSPORT_BUSY",
    });
  });

  it("uses lease-generation CAS so a stale worker cannot finalize recovered post-DATA work", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("worker-old", now, { db: testDb.db, batchSize: 1, ...lease });
    let release!: (outcome: SmtpOutcome) => void;
    const transport = { send: vi.fn(() => new Promise<SmtpOutcome>((resolve) => { release = resolve; })) };
    const processing = processDelivery(delivery.id, "worker-old", { db: testDb.db, transport, now: () => now });
    await vi.waitFor(async () => {
      expect((await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).dispatchedAt).toEqual(now);
    });
    await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: { leaseExpiresAt: new Date(now.getTime() - 1) } });
    await claimDueDeliveries("worker-new", now, { db: testDb.db, batchSize: 1, ...lease });
    release(accepted);
    await expect(processing).resolves.toMatchObject({ status: "ACCEPTED_STALE" });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      providerMessageId: accepted.providerMessageId,
      responseSummary: "250 queued; protocolStage=POST_DATA",
    });
  });

  it("renews an expired batch claim from the actual dispatch instant before entering SMTP", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("slow-batch-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const lateDispatch = new Date(now.getTime() + lease.leaseDurationMs + 1_000);
    let release!: (outcome: SmtpOutcome) => void;
    const transport = { send: vi.fn(() => new Promise<SmtpOutcome>((resolve) => { release = resolve; })) };

    const processing = processDelivery(delivery.id, "slow-batch-worker", {
      db: testDb.db,
      transport,
      now: () => lateDispatch,
      leaseDurationMs: lease.leaseDurationMs,
    });
    await vi.waitFor(async () => {
      expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .toMatchObject({
          dispatchedAt: lateDispatch,
          leaseExpiresAt: new Date(lateDispatch.getTime() + lease.leaseDurationMs),
        });
    });

    const reclaimed = await claimDueDeliveries("concurrent-reaper", lateDispatch, {
      db: testDb.db,
      batchSize: 1,
      ...lease,
    });
    expect(reclaimed).toHaveLength(0);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: OnboardingMailDeliveryStatus.SENDING, workerId: "slow-batch-worker" });

    release(accepted);
    await expect(processing).resolves.toMatchObject({ status: OnboardingMailDeliveryStatus.SENT });
  });

  it("classifies a thrown final persistence error after SMTP acceptance as ACCEPTED_STALE", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("accepted-save-error-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const realDelegate = testDb.db.onboardingMailDelivery;
    const failingDelegate = new Proxy(realDelegate, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: { data?: { status?: OnboardingMailDeliveryStatus } }) => {
            if (args.data?.status === OnboardingMailDeliveryStatus.SENT) {
              throw new Error("database busy after accepted employee@example.invalid");
            }
            return realDelegate.updateMany(args as Parameters<typeof realDelegate.updateMany>[0]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testDb.db, {
      get(target, property) {
        if (property === "onboardingMailDelivery") return failingDelegate;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;

    await expect(processDelivery(delivery.id, "accepted-save-error-worker", {
      db,
      transport: { send: async () => accepted },
      now: () => now,
      leaseDurationMs: lease.leaseDurationMs,
    })).resolves.toMatchObject({ id: delivery.id, status: "ACCEPTED_STALE", outcome: accepted });

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      workerId: null,
      leaseExpiresAt: null,
      retryable: false,
      nextRetryAt: null,
      failureCode: "ACCEPTED_STATE_UNPERSISTED",
      providerMessageId: accepted.providerMessageId,
      responseSummary: "250 queued; protocolStage=POST_DATA",
    });
  });

  it("backfills accepted provider evidence onto an unresolved concurrent UNKNOWN without changing its state", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("accepted-cas-loss-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async (): Promise<SmtpOutcome> => {
      await testDb.db.onboardingMailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: OnboardingMailDeliveryStatus.UNKNOWN,
          workerId: null,
          leaseExpiresAt: null,
          failureCode: "CONCURRENT_REAPER",
        },
      });
      return accepted;
    }) };

    await expect(processDelivery(delivery.id, "accepted-cas-loss-worker", {
      db: testDb.db,
      transport,
      now: () => now,
      leaseDurationMs: lease.leaseDurationMs,
    })).resolves.toMatchObject({ id: delivery.id, status: "ACCEPTED_STALE", outcome: accepted });

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      workerId: null,
      retryable: false,
      failureCode: "CONCURRENT_REAPER",
      unknownResolution: null,
      providerMessageId: accepted.providerMessageId,
      responseSummary: "250 queued; protocolStage=POST_DATA",
    });
  });

  it("does not backfill accepted evidence after an UNKNOWN delivery has been manually resolved", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("resolved-cas-loss-worker", now, { db: testDb.db, batchSize: 1, ...lease });
    const transport = { send: vi.fn(async (): Promise<SmtpOutcome> => {
      await testDb.db.onboardingMailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: OnboardingMailDeliveryStatus.UNKNOWN,
          workerId: null,
          leaseExpiresAt: null,
          unknownResolution: "CONFIRMED_FAILED_RESEND",
          unknownResolvedAt: now,
          failureCode: "CONCURRENT_MANUAL_RESOLUTION",
        },
      });
      return accepted;
    }) };

    await expect(processDelivery(delivery.id, "resolved-cas-loss-worker", {
      db: testDb.db,
      transport,
      now: () => now,
      leaseDurationMs: lease.leaseDurationMs,
    })).resolves.toMatchObject({ status: "ACCEPTED_STALE" });

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      unknownResolution: "CONFIRMED_FAILED_RESEND",
      providerMessageId: null,
      responseSummary: null,
    });
  });

  it("keeps the SMTP network wait outside SQLite transactions", async () => {
    const { delivery } = await fixture(testDb.db);
    await claimDueDeliveries("worker", now, { db: testDb.db, batchSize: 1, ...lease });
    let release!: (outcome: SmtpOutcome) => void;
    const processing = processDelivery(delivery.id, "worker", {
      db: testDb.db,
      transport: { send: () => new Promise<SmtpOutcome>((resolve) => { release = resolve; }) },
      now: () => now,
    });
    await vi.waitFor(async () => {
      expect((await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).dispatchedAt).toEqual(now);
    });
    await expect(testDb.db.systemSetting.update({ where: { id: "default" }, data: { showWrongAnswers: true } })).resolves.toBeTruthy();
    release(accepted);
    await processing;
  });

  it("resolves UNKNOWN idempotently and creates at most one linked resend with null idempotency", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN } });
    const first = await resolveUnknownDelivery(delivery.id, {
      resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "收件人确认未收到",
    }, { db: testDb.db, now: () => now });
    const second = await resolveUnknownDelivery(delivery.id, {
      resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "重复点击",
    }, { db: testDb.db, now: () => now });
    expect(first.resendDeliveryId).toBe(second.resendDeliveryId);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: first.resendDeliveryId! } })).toMatchObject({
      source: OnboardingMailDeliverySource.RESEND,
      idempotencyKey: null,
      resendOfId: delivery.id,
    });
  });

  it("returns the same linked resend for concurrent identical UNKNOWN resolutions", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN },
    });

    const [first, second] = await Promise.all([
      resolveUnknownDelivery(delivery.id, {
        resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "first",
      }, { db: testDb.db, now: () => now }),
      resolveUnknownDelivery(delivery.id, {
        resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "second",
      }, { db: testDb.db, now: () => now }),
    ]);

    expect(first.resendDeliveryId).toBeTruthy();
    expect(second).toEqual({ ...first });
    expect(await testDb.db.onboardingMailDelivery.count({ where: { resendOfId: delivery.id } })).toBe(1);
  });

  it("returns a stable conflict for concurrent contradictory UNKNOWN resolutions without leaking database errors", async () => {
    const { delivery } = await fixture(testDb.db);
    await testDb.db.onboardingMailDelivery.update({
      where: { id: delivery.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN },
    });

    const settled = await Promise.allSettled([
      resolveUnknownDelivery(delivery.id, {
        resolution: "CONFIRMED_FAILED_RESEND", resolverId: null, note: "resend",
      }, { db: testDb.db, now: () => now }),
      resolveUnknownDelivery(delivery.id, {
        resolution: "CONFIRMED_DELIVERED", resolverId: null, note: "delivered",
      }, { db: testDb.db, now: () => now }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(UnknownResolutionConflictError);
    expect(rejected[0].reason).toMatchObject({ code: "UNKNOWN_RESOLUTION_CONFLICT" });
    expect(String(rejected[0].reason)).not.toMatch(/P2002|P2028|busy|unique/i);
  });
});

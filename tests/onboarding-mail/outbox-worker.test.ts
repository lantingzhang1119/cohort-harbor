import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import type { SmtpOutcome } from "@/features/mail/smtp-transport";
import { claimDueDeliveries, createWelcomeDelivery } from "@/features/onboarding-mail/delivery-service";
import { runOnboardingMailCycle } from "@/features/onboarding-mail/outbox-worker";
import { createTestDatabase } from "../helpers/test-db";

const now = new Date("2026-07-22T04:00:00.000Z");

async function setupTemplate(db: PrismaClient) {
  const template = await db.onboardingMailTemplate.create({ data: {
    kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "欢迎信", enabled: true,
  } });
  const revision = await db.onboardingMailTemplateRevision.create({ data: {
    templateId: template.id, revisionNumber: 1, senderDisplayName: "HR",
    subject: "欢迎 {{name}}", htmlBody: "<p>欢迎 {{name}}</p>", textBody: "欢迎 {{name}}",
    fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
    styleConfig: {}, publishedBySnapshot: {},
  } });
  await db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
  return revision;
}

async function setup(db: PrismaClient) {
  const revision = await setupTemplate(db);
  const deliveries = [];
  for (let index = 0; index < 2; index += 1) {
    const employee = await db.user.create({ data: {
      employeeNo: `CYCLE-${index}`, name: `员工${index}`, email: `cycle-${index}@example.invalid`,
      role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash: "unused", hiredAt: now,
    } });
    deliveries.push(await createWelcomeDelivery({
      source: OnboardingMailDeliverySource.MANUAL,
      recipientId: employee.id,
      templateRevisionId: revision.id,
      scheduledLocalDate: null,
      scheduledAt: now,
    }, { db, now: () => now }));
  }
  return deliveries;
}

async function setupAutomaticCandidates(
  db: PrismaClient,
  dates: string[],
  automationEnabledAt = new Date("2026-07-20T00:00:00.000Z"),
) {
  await setupTemplate(db);
  await db.systemSetting.create({ data: {
    id: "default",
    onboardingMailAutomationEnabled: true,
    onboardingMailAutomationEnabledAt: automationEnabledAt,
  } });
  for (const [index, localDate] of dates.entries()) {
    await db.user.create({ data: {
      employeeNo: `WINDOW-${index}`,
      name: `窗口员工${index}`,
      email: `window-${index}@example.invalid`,
      role: Role.EMPLOYEE,
      sourceType: UserSource.MANUAL,
      passwordHash: "unused",
      hiredAt: new Date(`${localDate}T04:00:00.000Z`),
    } });
  }
}

describe("onboarding mail worker cycle", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => { testDb = await createTestDatabase(); });
  afterEach(async () => { await testDb.cleanup(); });

  it("does nothing unless the runtime kill switch is explicitly enabled", async () => {
    await setup(testDb.db);
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted", providerMessageId: null, responseSummary: null, protocolStage: "POST_DATA", ccRejectedCount: 0,
    }));
    const summary = await runOnboardingMailCycle({
      db: testDb.db, transport: { send }, workerId: "disabled-worker", now: () => now,
      runtimeEnabled: false,
    });
    expect(summary).toMatchObject({ runtimeEnabled: false, claimed: 0, processed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await testDb.db.onboardingMailDelivery.count({ where: { status: OnboardingMailDeliveryStatus.PENDING } })).toBe(2);
    await expect(runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "invalid-lookback",
      runtimeEnabled: false,
      lookbackDays: 8,
    })).rejects.toThrow("lookbackDays");
  });

  it("isolates local validation failure inside a batch and continues the other delivery", async () => {
    const [invalid, valid] = await setup(testDb.db);
    await testDb.db.onboardingMailDelivery.update({ where: { id: invalid.id }, data: { templateSnapshot: {} } });
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted", providerMessageId: "ok", responseSummary: "250", protocolStage: "POST_DATA", ccRejectedCount: 0,
    }));
    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "worker-1",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
    });
    expect(summary).toMatchObject({ claimed: 2, processed: 2, sent: 1, skipped: 1, errors: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: invalid.id } })).toMatchObject({ status: OnboardingMailDeliveryStatus.SKIPPED });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: valid.id } })).toMatchObject({ status: OnboardingMailDeliveryStatus.SENT });
  });

  it("reports uncaught delivery processing errors by id without exposing recipient email", async () => {
    const [failed, valid] = await setup(testDb.db);
    await testDb.db.systemSetting.create({ data: {
      id: "default",
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: new Date("2026-07-22T03:00:00.000Z"),
    } });
    await testDb.db.onboardingMailDelivery.update({
      where: { id: failed.id },
      data: {
        source: OnboardingMailDeliverySource.AUTOMATIC,
        scheduledLocalDate: "2026-07-22",
        scheduledAt: new Date(now.getTime() - 1_000),
      },
    });
    await testDb.db.onboardingMailDelivery.update({
      where: { id: valid.id },
      data: {
        source: OnboardingMailDeliverySource.AUTOMATIC,
        scheduledLocalDate: "2026-07-22",
      },
    });
    let nowCalls = 0;
    const cycleNow = () => {
      nowCalls += 1;
      if (nowCalls === 2) throw new Error("processing failed for cycle-0@example.invalid");
      return now;
    };
    const onError = vi.fn();
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "error-isolated",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "diagnostic-worker",
      now: cycleNow,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      onError,
    });

    expect(summary).toMatchObject({ claimed: 2, processed: 1, sent: 1, errors: 1 });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({
      deliveryId: failed.id,
      code: "UNCAUGHT_PROCESSING_ERROR",
      errorType: "Error",
      errorSummary: "processing failed for [redacted-email]",
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain("cycle-0@example.invalid");
  });

  it("counts an accepted SMTP result whose final CAS is lost and emits an actionable identifier-only diagnostic", async () => {
    const [delivery] = await setup(testDb.db);
    const onError = vi.fn();
    const send = vi.fn(async (): Promise<SmtpOutcome> => {
      await testDb.db.onboardingMailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: OnboardingMailDeliveryStatus.UNKNOWN,
          workerId: null,
          leaseExpiresAt: null,
          failureCode: "CONCURRENT_RECOVERY",
        },
      });
      return {
        kind: "accepted",
        providerMessageId: "provider-secret-message-id",
        responseSummary: "250 accepted employee@example.invalid",
        protocolStage: "POST_DATA",
        ccRejectedCount: 0,
      };
    });

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "accepted-stale-worker",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 1,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
      onError,
    });

    expect(summary).toMatchObject({ processed: 1, sent: 0, stale: 0, acceptedStale: 1, errors: 0 });
    expect(onError).toHaveBeenCalledWith({ deliveryId: delivery.id, code: "ACCEPTED_STALE" });
    expect(JSON.stringify(onError.mock.calls)).not.toMatch(/provider-secret|employee@example/i);
  });

  it("emits identifier-only diagnostics for UNKNOWN, FAILED, and STALE outcomes", async () => {
    const [unknownDelivery, failedDelivery] = await setup(testDb.db);
    const employee = await testDb.db.user.create({ data: {
      employeeNo: "CYCLE-STALE", name: "过期员工", email: "stale@example.invalid",
      role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash: "unused", hiredAt: now,
    } });
    const staleDelivery = await createWelcomeDelivery({
      source: OnboardingMailDeliverySource.MANUAL,
      recipientId: employee.id,
      templateRevisionId: unknownDelivery.templateRevisionId,
      scheduledLocalDate: null,
      scheduledAt: now,
    }, { db: testDb.db, now: () => now });
    const onError = vi.fn();
    const send = vi.fn(async (message): Promise<SmtpOutcome> => {
      if (message.to.email === "cycle-1@example.invalid") {
        return {
          kind: "definite-terminal", failureCode: "SMTP_550",
          errorSummary: "550 failed cycle-1@example.invalid provider-id-secret",
          protocolStage: "ENVELOPE",
        };
      }
      if (message.to.email === "stale@example.invalid") {
        await testDb.db.onboardingMailDelivery.update({
          where: { id: staleDelivery.id },
          data: { status: OnboardingMailDeliveryStatus.UNKNOWN, workerId: null, leaseExpiresAt: null },
        });
      }
      return {
        kind: "ambiguous", failureCode: "SMTP_AMBIGUOUS",
        errorSummary: `lost response for ${message.to.email} provider-id-secret`,
        protocolStage: "DATA",
      };
    });

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "terminal-diagnostic-worker",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      onError,
    });

    expect(summary).toMatchObject({ unknown: 1, failed: 1, stale: 1, errors: 0 });
    expect(onError.mock.calls.map(([diagnostic]) => diagnostic)).toEqual(expect.arrayContaining([
      { deliveryId: unknownDelivery.id, code: "UNKNOWN", failureCode: "SMTP_AMBIGUOUS" },
      { deliveryId: failedDelivery.id, code: "FAILED", failureCode: "SMTP_550" },
      { deliveryId: staleDelivery.id, code: "STALE", failureCode: "SMTP_AMBIGUOUS" },
    ]));
    expect(JSON.stringify(onError.mock.calls)).not.toMatch(/@example|provider-id-secret/i);
  });

  it("stops using an unusable transport and immediately releases the untouched batch tail", async () => {
    const [uncertain, untouched] = await setup(testDb.db);
    let usable = true;
    const onError = vi.fn();
    const send = vi.fn(async (): Promise<SmtpOutcome> => {
      if (!usable) throw new Error("poisoned transport must not be called again");
      usable = false;
      return {
        kind: "ambiguous",
        failureCode: "SMTP_AMBIGUOUS",
        errorSummary: "final response unavailable",
        protocolStage: "DATA",
      };
    });

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send, isUsable: () => usable },
      workerId: "poisoned-batch-worker",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
      onError,
    });

    expect(summary).toMatchObject({ claimed: 2, processed: 1, unknown: 1, errors: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      deliveryId: uncertain.id,
      code: "UNKNOWN",
      failureCode: "SMTP_AMBIGUOUS",
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: uncertain.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      attemptCount: 1,
      retryable: false,
    });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: untouched.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.PENDING,
      attemptCount: 0,
      workerId: null,
      leaseExpiresAt: null,
      dispatchedAt: null,
      retryable: false,
      failureCode: "SMTP_TRANSPORT_UNUSABLE_BATCH_RELEASE",
    });
  });

  it("releases the batch tail when outcome persistence throws after the transport becomes unusable", async () => {
    const [uncertain, untouched] = await setup(testDb.db);
    let usable = true;
    const realDelegate = testDb.db.onboardingMailDelivery;
    const failingDelegate = new Proxy(realDelegate, {
      get(target, property) {
        if (property === "updateMany") {
          return async (args: { where?: { id?: string }; data?: { status?: OnboardingMailDeliveryStatus } }) => {
            if (args.where?.id === uncertain.id && args.data?.status === OnboardingMailDeliveryStatus.UNKNOWN) {
              throw new Error("database busy while preserving ambiguous outcome");
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
    const send = vi.fn(async (): Promise<SmtpOutcome> => {
      if (!usable) throw new Error("unusable transport must not be called again");
      usable = false;
      return {
        kind: "ambiguous",
        failureCode: "SMTP_AMBIGUOUS",
        errorSummary: "final response unavailable",
        protocolStage: "DATA",
      };
    });

    const summary = await runOnboardingMailCycle({
      db,
      transport: { send, isUsable: () => usable },
      workerId: "poisoned-persistence-worker",
      now: () => now,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
    });

    expect(summary).toMatchObject({ claimed: 2, processed: 0, errors: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: untouched.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.PENDING,
      attemptCount: 0,
      workerId: null,
      failureCode: "SMTP_TRANSPORT_UNUSABLE_BATCH_RELEASE",
    });
  });

  it("renews the untouched batch tail between slow messages before another worker can reclaim it", async () => {
    const [first, tail] = await setup(testDb.db);
    let clock = now;
    let releaseTailLookup!: () => void;
    let markTailLookupStarted!: () => void;
    const tailLookupStarted = new Promise<void>((resolve) => { markTailLookupStarted = resolve; });
    const tailLookupGate = new Promise<void>((resolve) => { releaseTailLookup = resolve; });
    const realDelegate = testDb.db.onboardingMailDelivery;
    const delayedDelegate = new Proxy(realDelegate, {
      get(target, property) {
        if (property === "findFirst") {
          return async (args: { where?: { id?: string } }) => {
            if (args.where?.id === tail.id) {
              markTailLookupStarted();
              await tailLookupGate;
            }
            return realDelegate.findFirst(args as Parameters<typeof realDelegate.findFirst>[0]);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testDb.db, {
      get(target, property) {
        if (property === "onboardingMailDelivery") return delayedDelegate;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const send = vi.fn(async (): Promise<SmtpOutcome> => {
      if (send.mock.calls.length === 1) clock = new Date(now.getTime() + 25_000);
      return {
        kind: "accepted",
        providerMessageId: null,
        responseSummary: "250 queued",
        protocolStage: "POST_DATA",
        ccRejectedCount: 0,
      };
    });

    const cycle = runOnboardingMailCycle({
      db,
      transport: { send },
      workerId: "slow-batch-worker",
      now: () => clock,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
    });

    try {
      await tailLookupStarted;
      expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: first.id } }))
        .toMatchObject({ status: OnboardingMailDeliveryStatus.SENT });
      expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: tail.id } }))
        .toMatchObject({
          status: OnboardingMailDeliveryStatus.SENDING,
          workerId: "slow-batch-worker",
          dispatchedAt: null,
          leaseExpiresAt: new Date(now.getTime() + 55_000),
        });

      const reclaimed = await claimDueDeliveries("concurrent-tail-worker", new Date(now.getTime() + 31_000), {
        db: testDb.db,
        batchSize: 1,
        leaseDurationMs: 30_000,
        transportHardTimeoutMs: 20_000,
        safetyMarginMs: 10_000,
      });
      expect(reclaimed).toHaveLength(0);
    } finally {
      releaseTailLookup();
      await cycle;
    }

    expect(send).toHaveBeenCalledTimes(2);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: tail.id } }))
      .toMatchObject({ status: OnboardingMailDeliveryStatus.SENT });
  });

  it("protects the batch tail before awaiting a slow diagnostic sink", async () => {
    const [, tail] = await setup(testDb.db);
    let clock = now;
    let releaseDiagnostic!: () => void;
    let markDiagnosticStarted!: () => void;
    const diagnosticStarted = new Promise<void>((resolve) => { markDiagnosticStarted = resolve; });
    const diagnosticGate = new Promise<void>((resolve) => { releaseDiagnostic = resolve; });
    const send = vi.fn(async (): Promise<SmtpOutcome> => {
      if (send.mock.calls.length === 1) {
        clock = new Date(now.getTime() + 25_000);
        return {
          kind: "ambiguous",
          failureCode: "SMTP_AMBIGUOUS",
          errorSummary: "final response unavailable",
          protocolStage: "DATA",
        };
      }
      return {
        kind: "accepted",
        providerMessageId: null,
        responseSummary: "250 queued",
        protocolStage: "POST_DATA",
        ccRejectedCount: 0,
      };
    });
    const onError = vi.fn(async () => {
      markDiagnosticStarted();
      await diagnosticGate;
    });

    const cycle = runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "slow-diagnostic-worker",
      now: () => clock,
      runtimeEnabled: true,
      enqueueAutomatic: false,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
      onError,
    });

    try {
      await diagnosticStarted;
      expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: tail.id } })).toMatchObject({
        status: OnboardingMailDeliveryStatus.SENDING,
        workerId: "slow-diagnostic-worker",
        dispatchedAt: null,
        leaseExpiresAt: new Date(now.getTime() + 55_000),
      });
      const reclaimed = await claimDueDeliveries("diagnostic-race-worker", new Date(now.getTime() + 31_000), {
        db: testDb.db,
        batchSize: 1,
        leaseDurationMs: 30_000,
        transportHardTimeoutMs: 20_000,
        safetyMarginMs: 10_000,
      });
      expect(reclaimed).toHaveLength(0);
    } finally {
      releaseDiagnostic();
      await cycle;
    }

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("bounds a hanging diagnostic sink within the lease safety margin and swallows a late rejection", async () => {
    const [, tail] = await setup(testDb.db);
    let markDiagnosticStarted!: () => void;
    let rejectDiagnostic!: (error: Error) => void;
    const diagnosticStarted = new Promise<void>((resolve) => { markDiagnosticStarted = resolve; });
    const diagnosticGate = new Promise<void>((_resolve, reject) => { rejectDiagnostic = reject; });
    const send = vi.fn(async (): Promise<SmtpOutcome> => send.mock.calls.length === 1
      ? {
        kind: "ambiguous",
        failureCode: "SMTP_AMBIGUOUS",
        errorSummary: "final response unavailable",
        protocolStage: "DATA",
      }
      : {
        kind: "accepted",
        providerMessageId: null,
        responseSummary: "250 queued",
        protocolStage: "POST_DATA",
        ccRejectedCount: 0,
      });
    const onError = vi.fn(() => {
      markDiagnosticStarted();
      return diagnosticGate;
    });
    let cycle: ReturnType<typeof runOnboardingMailCycle> | undefined;

    vi.useFakeTimers();
    try {
      cycle = runOnboardingMailCycle({
        db: testDb.db,
        transport: { send },
        workerId: "bounded-diagnostic-worker",
        now: () => now,
        runtimeEnabled: true,
        enqueueAutomatic: false,
        batchSize: 10,
        leaseDurationMs: 30_000,
        transportHardTimeoutMs: 20_000,
        safetyMarginMs: 10_000,
        onError,
      });
      let completed = false;
      void cycle.then(() => { completed = true; });

      await diagnosticStarted;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);

      const summary = await cycle;
      expect(summary).toMatchObject({ processed: 2, unknown: 1, sent: 1, errors: 0 });
      expect(send).toHaveBeenCalledTimes(2);
      expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: tail.id } }))
        .toMatchObject({ status: OnboardingMailDeliveryStatus.SENT });
    } finally {
      rejectDiagnostic(new Error("late diagnostic failure"));
      await cycle?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("backfills every Shanghai calendar date in the lookback window without crossing the automation floor", async () => {
    await setupAutomaticCandidates(
      testDb.db,
      ["2026-07-20", "2026-07-21", "2026-07-22"],
      new Date("2026-07-21T00:00:00.000Z"),
    );
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "window-backfill",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "lookback-worker",
      now: () => now,
      runtimeEnabled: true,
      lookbackDays: 2,
      batchSize: 10,
      confirmBulk: true,
    });

    expect(summary).toMatchObject({ enqueued: 2, claimed: 2, processed: 2, sent: 2 });
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { source: OnboardingMailDeliverySource.AUTOMATIC },
      orderBy: { scheduledLocalDate: "asc" },
      select: { scheduledLocalDate: true },
    })).toEqual([
      { scheduledLocalDate: "2026-07-21" },
      { scheduledLocalDate: "2026-07-22" },
    ]);
  });

  it("keeps the automatic enqueue window fixed when the clock crosses Shanghai midnight", async () => {
    await setupAutomaticCandidates(
      testDb.db,
      ["2026-07-21", "2026-07-22"],
      new Date("2026-07-21T00:00:00.000Z"),
    );
    const beforeMidnight = new Date("2026-07-22T15:59:59.000Z");
    const afterMidnight = new Date("2026-07-22T16:00:01.000Z");
    let clockReads = 0;
    const crossingMidnight = () => {
      clockReads += 1;
      return clockReads === 1 ? beforeMidnight : afterMidnight;
    };
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "midnight-window",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "midnight-worker",
      now: crossingMidnight,
      runtimeEnabled: true,
      lookbackDays: 1,
      confirmBulk: true,
      batchSize: 10,
    });

    expect(summary.enqueued).toBe(2);
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { source: OnboardingMailDeliverySource.AUTOMATIC },
      orderBy: { scheduledLocalDate: "asc" },
      select: { scheduledLocalDate: true },
    })).toEqual([
      { scheduledLocalDate: "2026-07-21" },
      { scheduledLocalDate: "2026-07-22" },
    ]);
  });

  it("keeps an explicit local date scoped to that single Shanghai calendar day", async () => {
    await setupAutomaticCandidates(testDb.db, ["2026-07-20", "2026-07-21", "2026-07-22"]);
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "explicit-date",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "explicit-date-worker",
      now: () => now,
      runtimeEnabled: true,
      localDate: "2026-07-21",
      lookbackDays: 2,
      batchSize: 10,
      confirmBulk: true,
    });

    expect(summary).toMatchObject({ enqueued: 1, claimed: 1, processed: 1, sent: 1 });
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { source: OnboardingMailDeliverySource.AUTOMATIC },
      select: { scheduledLocalDate: true },
    })).toEqual([{ scheduledLocalDate: "2026-07-21" }]);
  });

  it("records bulk confirmation per date and continues other lookback dates", async () => {
    await setupAutomaticCandidates(testDb.db, [
      "2026-07-20",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-22",
    ]);
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "bulk-date-isolation",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "bulk-date-worker",
      now: () => now,
      runtimeEnabled: true,
      lookbackDays: 2,
      bulkConfirmThreshold: 1,
      batchSize: 10,
    });

    expect(summary).toMatchObject({
      bulkConfirmationRequired: 4,
      bulkConfirmationDates: [
        { localDate: "2026-07-20", count: 2 },
        { localDate: "2026-07-22", count: 2 },
      ],
      enqueued: 1,
      claimed: 1,
      processed: 1,
      sent: 1,
    });
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { source: OnboardingMailDeliverySource.AUTOMATIC },
      select: { scheduledLocalDate: true },
    })).toEqual([{ scheduledLocalDate: "2026-07-21" }]);
  });

  it("continues pending and retryable deliveries when automatic enqueue requires bulk confirmation", async () => {
    const [pending, retryable] = await setup(testDb.db);
    await testDb.db.systemSetting.create({ data: {
      id: "default",
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: new Date("2026-07-22T03:00:00.000Z"),
    } });
    await testDb.db.onboardingMailDelivery.update({
      where: { id: pending.id },
      data: {
        source: OnboardingMailDeliverySource.AUTOMATIC,
        scheduledLocalDate: "2026-07-22",
      },
    });
    await testDb.db.onboardingMailDelivery.update({
      where: { id: retryable.id },
      data: {
        source: OnboardingMailDeliverySource.AUTOMATIC,
        scheduledLocalDate: "2026-07-22",
        status: OnboardingMailDeliveryStatus.FAILED,
        retryable: true,
        nextRetryAt: now,
      },
    });
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted",
      providerMessageId: "bulk-queue-continued",
      responseSummary: "250",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    }));

    const summary = await runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "bulk-confirmation-worker",
      now: () => now,
      runtimeEnabled: true,
      bulkConfirmThreshold: 1,
      batchSize: 10,
      leaseDurationMs: 30_000,
      transportHardTimeoutMs: 20_000,
      safetyMarginMs: 10_000,
    });

    expect(summary).toMatchObject({
      bulkConfirmationRequired: 2,
      enqueued: 0,
      claimed: 2,
      processed: 2,
      sent: 2,
      errors: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { source: OnboardingMailDeliverySource.AUTOMATIC },
      orderBy: { id: "asc" },
      select: { id: true },
    })).toEqual([pending.id, retryable.id].sort().map((id) => ({ id })));
    expect(await testDb.db.onboardingMailDelivery.findMany({
      where: { id: { in: [pending.id, retryable.id] } },
      select: { status: true },
    })).toEqual([
      { status: OnboardingMailDeliveryStatus.SENT },
      { status: OnboardingMailDeliveryStatus.SENT },
    ]);
  });

  it("continues to throw enqueue failures other than bulk confirmation", async () => {
    await setup(testDb.db);
    await testDb.db.systemSetting.create({ data: {
      id: "default",
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: new Date("2026-07-22T03:00:00.000Z"),
    } });
    const send = vi.fn();

    await expect(runOnboardingMailCycle({
      db: testDb.db,
      transport: { send },
      workerId: "invalid-date-worker",
      now: () => now,
      runtimeEnabled: true,
      localDate: "invalid-date",
      bulkConfirmThreshold: 20,
    })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

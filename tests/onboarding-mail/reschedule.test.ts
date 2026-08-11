import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
  WorkLocation,
} from "@/generated/prisma/enums";
import { updateEmployee } from "@/features/employees/employee-service";
import { claimDueDeliveries, createWelcomeDelivery } from "@/features/onboarding-mail/delivery-service";
import { rescheduleAutomaticWelcomeMailForUsers } from "@/features/onboarding-mail/scheduler";
import { commitRosterImport, stageRosterImport } from "@/features/roster/import-commit-service";
import type { NormalizedRosterRow } from "@/features/roster/types";
import { createTestDatabase } from "../helpers/test-db";

const day22 = new Date("2026-07-22T00:00:00.000Z");
const day23 = new Date("2026-07-23T00:00:00.000Z");
const shanghaiBusinessNow = new Date("2026-07-23T04:00:00.000Z");

async function mailFixture(db: PrismaClient, sourceType: UserSource) {
  const actor = await db.user.create({ data: {
    employeeNo: `ADMIN-${Math.random()}`, name: "管理员", role: Role.ADMIN,
    sourceType: UserSource.MANUAL, passwordHash: "unused",
  } });
  const employee = await db.user.create({ data: {
    employeeNo: `RESCHEDULE-${Math.random()}`, name: "改期员工", email: `reschedule-${Math.random()}@example.invalid`,
    role: Role.EMPLOYEE, sourceType, passwordHash: "unused", hiredAt: day22, workLocation: WorkLocation.SHANGHAI,
  } });
  const template = await db.onboardingMailTemplate.create({ data: {
    kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "欢迎信", enabled: true, defaultSendTime: "09:00",
  } });
  const revision = await db.onboardingMailTemplateRevision.create({ data: {
    templateId: template.id, revisionNumber: 1, senderDisplayName: "HR",
    subject: "欢迎 {{name}}", htmlBody: "<p>欢迎 {{name}}</p>", textBody: "欢迎 {{name}}",
    fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
    styleConfig: {}, publishedBySnapshot: {},
  } });
  await db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
  await db.systemSetting.create({ data: {
    id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: new Date("2026-07-22T07:00:00.000Z"),
  } });
  const delivery = await createWelcomeDelivery({
    source: OnboardingMailDeliverySource.AUTOMATIC,
    recipientId: employee.id,
    templateRevisionId: revision.id,
    scheduledLocalDate: "2026-07-22",
    scheduledAt: new Date("2026-07-22T01:00:00.000Z"),
  }, { db });
  return { actor, employee, delivery };
}

describe("welcome-mail rescheduling from employee mutations", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(shanghaiBusinessNow);
    testDb = await createTestDatabase();
  });
  afterEach(async () => {
    try {
      if (testDb) await testDb.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending automatic row and rebuilds it when the employee form changes hire date", async () => {
    const { actor, employee, delivery } = await mailFixture(testDb.db, UserSource.MANUAL);
    await updateEmployee(testDb.db, employee.id, { hiredAt: day23 }, actor.id);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.CANCELLED,
      retryable: false,
    });
    const rebuilt = await testDb.db.onboardingMailDelivery.findFirstOrThrow({ where: { recipientId: employee.id, status: OnboardingMailDeliveryStatus.PENDING } });
    expect(rebuilt).toMatchObject({
      scheduledLocalDate: "2026-07-23",
      scheduledAt: new Date("2026-07-23T01:00:00.000Z"),
      idempotencyKey: `welcome:${employee.id}:2026-07-23`,
    });
  });

  it("cancels a retryable failed row and rebuilds it from the bulk roster commit path", async () => {
    const { actor, employee, delivery } = await mailFixture(testDb.db, UserSource.EXCEL);
    await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: {
      status: OnboardingMailDeliveryStatus.FAILED, retryable: true, nextRetryAt: new Date("2026-07-22T02:00:00.000Z"),
    } });
    const row: NormalizedRosterRow = {
      rowNumber: 2, employeeNo: employee.employeeNo, name: employee.name, email: employee.email!,
      firstDepartment: null, secondDepartment: null, position: null, personnelStatus: "正式",
      hiredAt: day23, leftAt: null, workLocation: WorkLocation.SHANGHAI, invalidDateFields: [],
    };
    const batch = await stageRosterImport(testDb.db, {
      rows: [row],
      metadata: { sourceName: "ExcelRosterSource", originalFileName: "change.xlsx", fileHash: "reschedule-hash" },
      actorId: actor.id,
    });
    await commitRosterImport(testDb.db, { batchId: batch.batchId, decisions: [], actorId: actor.id });
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.CANCELLED,
      retryable: false,
      nextRetryAt: null,
    });
    expect(await testDb.db.onboardingMailDelivery.findFirstOrThrow({ where: { recipientId: employee.id, status: OnboardingMailDeliveryStatus.PENDING } })).toMatchObject({
      scheduledLocalDate: "2026-07-23",
    });
  });

  it.each(["claimed", "dispatched", "sent"] as const)(
    "does not cancel or rebuild when the old automatic row becomes %s after the candidate read",
    async (interleaving) => {
      const { employee, delivery } = await mailFixture(testDb.db, UserSource.MANUAL);
      await testDb.db.user.update({ where: { id: employee.id }, data: { hiredAt: day23 } });
      let hookCalls = 0;

      const result = await rescheduleAutomaticWelcomeMailForUsers(testDb.db, [employee.id], {
        hooks: {
          afterCandidatesRead: async () => {
            hookCalls += 1;
            await claimDueDeliveries("interleaving-worker", new Date("2026-07-22T01:00:00.000Z"), {
              db: testDb.db,
              batchSize: 1,
              leaseDurationMs: 30_000,
              transportHardTimeoutMs: 20_000,
              safetyMarginMs: 10_000,
            });
            if (interleaving === "dispatched" || interleaving === "sent") {
              await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: {
                dispatchedAt: new Date("2026-07-22T01:00:00.100Z"),
                ...(interleaving === "sent" ? {
                  status: OnboardingMailDeliveryStatus.SENT,
                  sentAt: new Date("2026-07-22T01:00:00.200Z"),
                  workerId: null,
                  leaseExpiresAt: null,
                } : {}),
              } });
            }
          },
        },
      });

      expect(hookCalls).toBe(1);
      expect(result).toMatchObject({ cancelled: 0, rebuilt: 0 });
      const old = await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(old.status).toBe(interleaving === "sent" ? OnboardingMailDeliveryStatus.SENT : OnboardingMailDeliveryStatus.SENDING);
      expect(old.idempotencyKey).toBe(`welcome:${employee.id}:2026-07-22`);
      expect(await testDb.db.onboardingMailDelivery.count({ where: { recipientId: employee.id } })).toBe(1);
    },
  );

  it("rolls back cancellation and idempotency-key release when replacement insertion fails", async () => {
    const { employee, delivery } = await mailFixture(testDb.db, UserSource.MANUAL);
    await testDb.db.user.update({ where: { id: employee.id }, data: { hiredAt: day23 } });

    await expect(rescheduleAutomaticWelcomeMailForUsers(testDb.db, [employee.id], {
      hooks: { beforeReplacementInsert: () => { throw new Error("deterministic rebuild failure"); } },
    })).rejects.toThrow("deterministic rebuild failure");

    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: OnboardingMailDeliveryStatus.PENDING,
      idempotencyKey: `welcome:${employee.id}:2026-07-22`,
      failureCode: null,
    });
    expect(await testDb.db.onboardingMailDelivery.count({ where: { recipientId: employee.id } })).toBe(1);
  });
});

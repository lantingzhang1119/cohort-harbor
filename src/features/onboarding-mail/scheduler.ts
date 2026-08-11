import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliverySource, OnboardingMailDeliveryStatus, OnboardingMailTemplateKind } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { resolveCcRecipients } from "@/features/onboarding-mail/cc-service";
import { prepareWelcomeDeliveryData } from "@/features/onboarding-mail/delivery-service";
import {
  explainWelcomeEligibility,
  shanghaiCalendarDate,
  shanghaiDateRange,
  validatedWelcomeMailLookbackDays,
} from "@/features/onboarding-mail/eligibility-service";
import { renderWelcomeTemplate } from "@/features/onboarding-mail/template-service";
import { prisma } from "@/lib/db/client";

export type ActorSnapshot = { id?: string; employeeNo?: string; name?: string; email?: string | null; role?: string };
export type EnqueueSummary = { matched: number; eligible: number; enqueued: number; duplicate: number; excluded: number };
export type EnqueueOptions = {
  db?: PrismaClient;
  now?: () => Date;
  lookbackDays?: number;
  bulkConfirmThreshold?: number;
  confirmBulk?: boolean;
  expectedEligibleCount?: number;
  companyName?: string;
};

export class WelcomeMailBulkConfirmationError extends Error {
  readonly code = "BULK_CONFIRMATION_REQUIRED";
  constructor(public readonly count: number) {
    super(`本次将创建 ${count} 封自动邮件，需要显式确认`);
    this.name = "WelcomeMailBulkConfirmationError";
  }
}

export class WelcomeMailSelectionChangedError extends Error {
  readonly code = "CONFIRMATION_MISMATCH";
  readonly status = 409;
  constructor(public readonly expectedCount: number, public readonly actualCount: number) {
    super("页面人数已变化，请刷新后重试");
    this.name = "WelcomeMailSelectionChangedError";
  }
}

export function scheduledWelcomeInstant(localDate: string, sendTime: string): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(sendTime);
  if (!match) throw new TypeError("模板发送时间必须是 HH:mm");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new TypeError("模板发送时间无效");
  const { start } = shanghaiDateRange(localDate);
  return new Date(start.getTime() + (hours * 60 + minutes) * 60_000);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: unknown; message?: unknown };
  return item.code === "P2002" || /unique constraint/i.test(String(item.message ?? ""));
}

export async function setWelcomeMailAutomationEnabled(
  enabled: boolean,
  actorId: string,
  options: { db?: PrismaClient; now?: () => Date } = {},
) {
  const db = options.db ?? prisma;
  const instant = (options.now ?? (() => new Date()))();
  return db.$transaction(async (transaction) => {
    const current = await transaction.systemSetting.findUnique({ where: { id: "default" } });
    if (!current) {
      return transaction.systemSetting.create({ data: {
        id: "default",
        onboardingMailAutomationEnabled: enabled,
        ...(enabled ? { onboardingMailAutomationEnabledAt: instant, onboardingMailAutomationEnabledById: actorId } : {}),
      } });
    }
    return transaction.systemSetting.update({ where: { id: "default" }, data: {
      onboardingMailAutomationEnabled: enabled,
      ...(enabled && current.onboardingMailAutomationEnabledAt === null ? {
        onboardingMailAutomationEnabledAt: instant,
        onboardingMailAutomationEnabledById: actorId,
      } : {}),
    } });
  });
}

export async function enqueueDueWelcomeMail(
  localDate: string,
  actor?: ActorSnapshot,
  options: EnqueueOptions = {},
): Promise<EnqueueSummary> {
  const db = options.db ?? prisma;
  const lookbackDays = validatedWelcomeMailLookbackDays(options.lookbackDays);
  const setting = await db.systemSetting.findUnique({ where: { id: "default" } });
  if (!setting?.onboardingMailAutomationEnabled || !setting.onboardingMailAutomationEnabledAt) {
    return { matched: 0, eligible: 0, enqueued: 0, duplicate: 0, excluded: 0 };
  }
  const floorDate = shanghaiCalendarDate(setting.onboardingMailAutomationEnabledAt);
  if (localDate < floorDate) return { matched: 0, eligible: 0, enqueued: 0, duplicate: 0, excluded: 0 };
  const { start, end } = shanghaiDateRange(localDate);
  const candidates = await db.user.findMany({
    where: { hiredAt: { gte: start, lt: end } },
    select: { id: true },
  });
  const eligible: Array<{ userId: string; revisionId: string }> = [];
  for (const candidate of candidates) {
    const result = await explainWelcomeEligibility(candidate.id, localDate, {
      db, now: options.now, lookbackDays, companyName: options.companyName,
    });
    if (result.eligible) eligible.push({ userId: candidate.id, revisionId: result.templateRevisionId });
  }
  const threshold = options.bulkConfirmThreshold ?? 20;
  if (options.expectedEligibleCount !== undefined && eligible.length !== options.expectedEligibleCount) {
    throw new WelcomeMailSelectionChangedError(options.expectedEligibleCount, eligible.length);
  }
  if (eligible.length > threshold && !options.confirmBulk) throw new WelcomeMailBulkConfirmationError(eligible.length);

  const template = await db.onboardingMailTemplate.findUniqueOrThrow({
    where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
  });
  let enqueued = 0;
  let duplicate = 0;
  for (const item of eligible) {
    const rendered = await renderWelcomeTemplate(item.revisionId, item.userId, {
      db, companyName: options.companyName ?? "", now: options.now?.(),
    });
    const cc = await resolveCcRecipients(rendered.ccEntries.map((entry) => entry.kind === "USER"
      ? { kind: "USER", userId: entry.userId!, displayName: entry.displayName, sortOrder: entry.sortOrder }
      : { kind: "EMAIL", email: entry.email!, displayName: entry.displayName, sortOrder: entry.sortOrder }), rendered.recipient, { db });
    const recipient = await db.user.findUniqueOrThrow({ where: { id: item.userId } });
    try {
      await db.onboardingMailDelivery.create({ data: {
        source: OnboardingMailDeliverySource.AUTOMATIC,
        idempotencyKey: `welcome:${item.userId}:${localDate}`,
        recipientId: item.userId,
        recipientEmailSnapshot: rendered.recipient.email,
        recipientSnapshot: snapshotUserIdentity(recipient),
        templateRevisionId: item.revisionId,
        templateSnapshot: {
          senderDisplayName: rendered.senderDisplayName,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        } as Prisma.InputJsonValue,
        fieldSummary: rendered.fields as Prisma.InputJsonValue,
        ccSnapshot: cc as Prisma.InputJsonValue,
        attachmentSummary: rendered.attachments.map((attachment) => ({
          id: attachment.id,
          role: attachment.role,
          fileAssetId: attachment.fileAssetId,
          materialVersionId: attachment.materialVersionId,
          displayName: attachment.displayName,
          contentId: attachment.contentId,
        })) as Prisma.InputJsonValue,
        scheduledLocalDate: localDate,
        scheduledAt: scheduledWelcomeInstant(localDate, template.defaultSendTime || "09:00"),
        actorId: actor?.id ?? null,
        actorSnapshot: actor ? actor as Prisma.InputJsonValue : undefined,
      } });
      enqueued += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      duplicate += 1;
    }
  }
  return { matched: candidates.length, eligible: eligible.length, enqueued, duplicate, excluded: candidates.length - eligible.length };
}

export async function rescheduleAutomaticWelcomeMailForUsers(
  db: PrismaClient,
  userIds: string[],
  options: {
    now?: () => Date;
    lookbackDays?: number;
    companyName?: string;
    hooks?: {
      afterCandidatesRead?: () => void | Promise<void>;
      beforeReplacementInsert?: () => void | Promise<void>;
    };
  } = {},
) {
  const ids = [...new Set(userIds)];
  const lookbackDays = validatedWelcomeMailLookbackDays(options.lookbackDays);
  let cancelled = 0;
  let rebuilt = 0;
  for (const userId of ids) {
    const cancellable = await db.onboardingMailDelivery.findMany({
      where: {
        recipientId: userId,
        source: OnboardingMailDeliverySource.AUTOMATIC,
        OR: [
          { status: OnboardingMailDeliveryStatus.PENDING },
          { status: OnboardingMailDeliveryStatus.FAILED, retryable: true, dispatchedAt: null },
        ],
        dispatchedAt: null,
      },
      select: {
        id: true,
        status: true,
        source: true,
        idempotencyKey: true,
        retryable: true,
        workerId: true,
        dispatchedAt: true,
        leaseGeneration: true,
      },
    });
    await options.hooks?.afterCandidatesRead?.();
    try {
      const result = await db.$transaction(async (transaction) => {
        const unsafe = await transaction.onboardingMailDelivery.findFirst({
          where: {
            recipientId: userId,
            source: OnboardingMailDeliverySource.AUTOMATIC,
            OR: [
              { status: { in: [
                OnboardingMailDeliveryStatus.SENDING,
                OnboardingMailDeliveryStatus.SENT,
                OnboardingMailDeliveryStatus.UNKNOWN,
              ] } },
              { dispatchedAt: { not: null } },
            ],
          },
          select: { id: true },
        });
        if (unsafe) return { cancelled: 0, rebuilt: 0 };

        const user = await transaction.user.findUnique({ where: { id: userId }, select: { id: true, hiredAt: true } });
        let replacement: Prisma.OnboardingMailDeliveryUncheckedCreateInput | null = null;
        if (user?.hiredAt) {
          const localDate = shanghaiCalendarDate(user.hiredAt);
          const eligibility = await explainWelcomeEligibility(user.id, localDate, {
            db: transaction as unknown as PrismaClient,
            now: options.now,
            lookbackDays,
            companyName: options.companyName,
          });
          if (eligibility.eligible) {
            const template = await transaction.onboardingMailTemplate.findUniqueOrThrow({
              where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
            });
            replacement = await prepareWelcomeDeliveryData({
              source: OnboardingMailDeliverySource.AUTOMATIC,
              recipientId: user.id,
              templateRevisionId: eligibility.templateRevisionId,
              scheduledLocalDate: localDate,
              scheduledAt: scheduledWelcomeInstant(localDate, template.defaultSendTime || "09:00"),
            }, { db: transaction, now: options.now, companyName: options.companyName });
          }
        }

        let cancelledHere = 0;
        for (const delivery of cancellable) {
          const updated = await transaction.onboardingMailDelivery.updateMany({
            where: {
              id: delivery.id,
              status: delivery.status,
              source: OnboardingMailDeliverySource.AUTOMATIC,
              idempotencyKey: delivery.idempotencyKey,
              retryable: delivery.retryable,
              workerId: delivery.workerId,
              dispatchedAt: null,
              leaseGeneration: delivery.leaseGeneration,
            },
            data: {
              status: OnboardingMailDeliveryStatus.CANCELLED,
              retryable: false,
              nextRetryAt: null,
              workerId: null,
              leaseExpiresAt: null,
              failureCode: "RECIPIENT_CHANGED",
              errorSummary: "员工资料或资格发生变化，自动任务已重排",
              ...(delivery.idempotencyKey ? { idempotencyKey: `cancelled:${delivery.id}:${delivery.idempotencyKey}` } : {}),
            },
          });
          if (updated.count !== 1) throw new RescheduleCasConflict();
          cancelledHere += 1;
        }
        if (!replacement) return { cancelled: cancelledHere, rebuilt: 0 };
        await options.hooks?.beforeReplacementInsert?.();
        await transaction.onboardingMailDelivery.create({ data: replacement });
        return { cancelled: cancelledHere, rebuilt: 1 };
      });
      cancelled += result.cancelled;
      rebuilt += result.rebuilt;
    } catch (error) {
      if (error instanceof RescheduleCasConflict) continue;
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { cancelled, rebuilt };
}

class RescheduleCasConflict extends Error {}

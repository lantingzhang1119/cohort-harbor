import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliverySource, OnboardingMailDeliveryStatus } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { mailSelectionDigest, MailAdminError, verifyMailConfirmationToken } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const schema = z.object({ deliveryIds: z.array(z.string().min(1)).min(1).max(100), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), displayedRecipientCount: z.number().int().positive(), confirmed: z.literal(true), confirmationToken: z.string().optional() });
type Deps = { db: PrismaClient; now: () => Date; bulkConfirmationSecret: string; bulkThreshold: number };
function isResendRace(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: unknown; message?: unknown };
  return ["P1008", "P2002", "P2034"].includes(String(item.code ?? ""))
    || /database is locked|busy|unique constraint/i.test(String(item.message ?? ""));
}
export function createOnboardingMailResendRoute(deps: Deps) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(deps.db, request);
      const input = schema.parse(await request.json());
      const ids = [...new Set(input.deliveryIds)];
      if (input.displayedRecipientCount !== ids.length) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "页面人数已变化，请刷新后重试");
      if (ids.length > deps.bulkThreshold) verifyMailConfirmationToken(input.confirmationToken, {
        action: "RESEND", localDate: input.localDate, count: ids.length, selectionDigest: mailSelectionDigest(ids),
      }, { secret: deps.bulkConfirmationSecret, now: deps.now() });
      try {
        await deps.db.$transaction(async (transaction) => {
          const originals = await transaction.onboardingMailDelivery.findMany({
            where: { id: { in: ids } }, include: { resendDelivery: true },
          });
          if (originals.length !== ids.length) {
            throw new MailAdminError("DELIVERY_NOT_RESENDABLE", 400, "所选投递不存在或不能重发");
          }
          if (originals.some((item) => item.resendDelivery)) {
            throw new MailAdminError("DELIVERY_ALREADY_RESENT", 409, "所选投递已创建重发");
          }
          if (originals.some((item) =>
            item.status !== OnboardingMailDeliveryStatus.SENT
            || item.source === OnboardingMailDeliverySource.TEST)) {
            throw new MailAdminError("DELIVERY_NOT_RESENDABLE", 400, "只能重发已发送且非测试的投递；结果未确认的投递必须逐条解决");
          }
          const instant = deps.now();
          for (const item of originals) await transaction.onboardingMailDelivery.create({ data: {
            status: OnboardingMailDeliveryStatus.PENDING,
            source: OnboardingMailDeliverySource.RESEND,
            recipientId: item.recipientId,
            recipientEmailSnapshot: item.recipientEmailSnapshot,
            recipientSnapshot: item.recipientSnapshot as Prisma.InputJsonValue,
            templateRevisionId: item.templateRevisionId,
            templateSnapshot: item.templateSnapshot as Prisma.InputJsonValue,
            fieldSummary: item.fieldSummary as Prisma.InputJsonValue,
            ccSnapshot: item.ccSnapshot as Prisma.InputJsonValue,
            attachmentSummary: item.attachmentSummary as Prisma.InputJsonValue,
            scheduledLocalDate: null,
            scheduledAt: instant,
            actorId: actor.id,
            actorSnapshot: snapshotUserIdentity(actor),
            resendOfId: item.id,
          } });
        });
      } catch (error) {
        if (error instanceof MailAdminError) throw error;
        if (isResendRace(error)) {
          const linked = await deps.db.onboardingMailDelivery.count({ where: { resendOfId: { in: ids } } });
          if (linked === ids.length) throw new MailAdminError("DELIVERY_ALREADY_RESENT", 409, "所选投递已创建重发");
        }
        throw error;
      }
      return NextResponse.json({ ok: true, created: ids.length }, { status: 201 });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
export async function POST(request: Request) {
  const env = getEnv();
  return createOnboardingMailResendRoute({
    db: prisma, now: () => new Date(), bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
    bulkThreshold: env.ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD,
  }).POST(request);
}

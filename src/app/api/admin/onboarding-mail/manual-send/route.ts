import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliverySource, OnboardingMailTemplateKind } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { mailSelectionDigest, MailAdminError, verifyMailConfirmationToken } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prepareWelcomeDeliveryData } from "@/features/onboarding-mail/delivery-service";
import {
  findQualifiedWelcomeMailRecipientIdsForDate,
  shanghaiCalendarDate,
} from "@/features/onboarding-mail/eligibility-service";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const schema = z.object({ employeeIds: z.array(z.string().min(1)).min(1).max(100), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), displayedRecipientCount: z.number().int().positive(), confirmed: z.literal(true), confirmationToken: z.string().optional() });
type Deps = { db: PrismaClient; now: () => Date; bulkConfirmationSecret: string; bulkThreshold: number };
function isManualSendRace(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: unknown; message?: unknown };
  return ["P1008", "P2002", "P2028", "P2034"].includes(String(item.code ?? ""))
    || /database is locked|busy|unique constraint/i.test(String(item.message ?? ""));
}
export function createOnboardingMailManualSendRoute(deps: Deps) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(deps.db, request);
      const input = schema.parse(await request.json());
      const ids = [...new Set(input.employeeIds)];
      if (input.displayedRecipientCount !== ids.length) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "页面人数已变化，请刷新后重试");
      if (input.localDate >= shanghaiCalendarDate(deps.now())) throw new MailAdminError("PAST_MISSED_ONLY", 400, "补发列表只能创建过去日期的手动发送");
      if (ids.length > deps.bulkThreshold) verifyMailConfirmationToken(input.confirmationToken, {
        action: "MANUAL_SEND", localDate: input.localDate, count: ids.length, selectionDigest: mailSelectionDigest(ids),
      }, { secret: deps.bulkConfirmationSecret, now: deps.now() });
      let created: number;
      try {
        created = await deps.db.$transaction(async (transaction) => {
          const recipientIds = await findQualifiedWelcomeMailRecipientIdsForDate(transaction, ids, input.localDate);
          if (recipientIds.length !== ids.length) throw new MailAdminError("RECIPIENT_MISMATCH", 400, "所选员工当前不可收件、不属于该补发日期或缺少邮箱");
          const existing = await transaction.onboardingMailDelivery.findFirst({
            where: { recipientId: { in: ids }, status: { not: "CANCELLED" } },
            select: { id: true },
          });
          if (existing) throw new MailAdminError("MANUAL_DELIVERY_EXISTS", 409, "所选员工已有未取消的欢迎邮件记录");
          const template = await transaction.onboardingMailTemplate.findUnique({ where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME } });
          if (!template?.currentRevisionId) throw new MailAdminError("PUBLISHED_TEMPLATE_REQUIRED", 409, "请先发布欢迎邮件模板");
          const instant = deps.now();
          for (const recipientId of ids) {
            const data = await prepareWelcomeDeliveryData({
              source: OnboardingMailDeliverySource.MANUAL,
              recipientId,
              templateRevisionId: template.currentRevisionId,
              scheduledLocalDate: null,
              scheduledAt: instant,
              actorId: actor.id,
              actorSnapshot: snapshotUserIdentity(actor),
            }, { db: transaction, now: deps.now });
            await transaction.onboardingMailDelivery.create({ data });
          }
          return ids.length;
        });
      } catch (error) {
        if (error instanceof MailAdminError) throw error;
        if (isManualSendRace(error)) {
          const existing = await deps.db.onboardingMailDelivery.findFirst({
            where: { recipientId: { in: ids }, status: { not: "CANCELLED" } },
            select: { id: true },
          });
          if (existing) throw new MailAdminError("MANUAL_DELIVERY_EXISTS", 409, "所选员工已有未取消的欢迎邮件记录");
        }
        throw error;
      }
      return NextResponse.json({ ok: true, created }, { status: 201 });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
export async function POST(request: Request) {
  const env = getEnv();
  return createOnboardingMailManualSendRoute({
    db: prisma, now: () => new Date(), bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
    bulkThreshold: env.ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD,
  }).POST(request);
}

import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliverySource, OnboardingMailDeliveryStatus } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  createMailConfirmationToken,
  mailSelectionDigest,
  MailAdminError,
} from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import {
  findQualifiedWelcomeMailRecipientIdsForDate,
  shanghaiCalendarDate,
} from "@/features/onboarding-mail/eligibility-service";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const schema = z.object({
  action: z.enum(["MANUAL_SEND", "RESEND"]),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  selectedIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();

type Dependencies = { db: PrismaClient; now: () => Date; bulkConfirmationSecret: string };

export function createOnboardingMailConfirmationRoute(deps: Dependencies) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      await requireAdminRequest(deps.db, request);
      const input = schema.parse(await request.json());
      const selectedIds = [...new Set(input.selectedIds)];
      if (selectedIds.length !== input.selectedIds.length) {
        throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "选择项包含重复记录，请刷新后重试");
      }
      if (input.action === "MANUAL_SEND") {
        if (input.localDate >= shanghaiCalendarDate(deps.now())) {
          throw new MailAdminError("PAST_MISSED_ONLY", 400, "补发确认只能使用过去日期");
        }
        const [recipients, existing] = await Promise.all([
          findQualifiedWelcomeMailRecipientIdsForDate(deps.db, selectedIds, input.localDate),
          deps.db.onboardingMailDelivery.count({ where: { recipientId: { in: selectedIds }, status: { not: OnboardingMailDeliveryStatus.CANCELLED } } }),
        ]);
        if (recipients.length !== selectedIds.length) throw new MailAdminError("RECIPIENT_MISMATCH", 400, "所选员工当前不可收件、不属于该补发日期或缺少邮箱");
        if (existing) throw new MailAdminError("MANUAL_DELIVERY_EXISTS", 409, "所选员工已有未取消的欢迎邮件记录");
      } else {
        const originals = await deps.db.onboardingMailDelivery.findMany({
          where: { id: { in: selectedIds } }, include: { resendDelivery: true },
        });
        if (originals.length !== selectedIds.length || originals.some((item) =>
          item.status !== OnboardingMailDeliveryStatus.SENT
          || item.source === OnboardingMailDeliverySource.TEST
          || item.resendDelivery)) {
          throw new MailAdminError("DELIVERY_NOT_RESENDABLE", 400, "只能确认已发送且非测试、尚未重发的投递");
        }
      }
      const token = createMailConfirmationToken({
        action: input.action,
        localDate: input.localDate,
        count: selectedIds.length,
        selectionDigest: mailSelectionDigest(selectedIds),
      }, { secret: deps.bulkConfirmationSecret, now: deps.now() });
      return NextResponse.json({
        ok: true,
        action: input.action,
        count: selectedIds.length,
        confirmationToken: token.token,
        expiresAt: token.expiresAt,
      });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}

export async function POST(request: Request) {
  const env = getEnv();
  return createOnboardingMailConfirmationRoute({
    db: prisma,
    now: () => new Date(),
    bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
  }).POST(request);
}

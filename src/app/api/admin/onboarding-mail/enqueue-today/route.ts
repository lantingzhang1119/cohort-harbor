import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { MailAdminError, verifyMailConfirmationToken } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { explainWelcomeEligibility, shanghaiCalendarDate, shanghaiDateRange } from "@/features/onboarding-mail/eligibility-service";
import { enqueueDueWelcomeMail } from "@/features/onboarding-mail/scheduler";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const schema = z.object({ localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), confirmed: z.literal(true), displayedRecipientCount: z.number().int().nonnegative(), confirmationToken: z.string().optional() });
type Dependencies = { db: PrismaClient; now: () => Date; bulkConfirmationSecret: string; bulkThreshold: number };

export function createOnboardingMailEnqueueTodayRoute(deps: Dependencies) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(deps.db, request);
      const input = schema.parse(await request.json());
      const currentDate = shanghaiCalendarDate(deps.now());
      if (input.localDate !== currentDate) throw new MailAdminError("DATE_MISMATCH", 400, "今日发送只能使用当前上海日期");
      const { start, end } = shanghaiDateRange(input.localDate);
      const users = await deps.db.user.findMany({ where: { hiredAt: { gte: start, lt: end } }, select: { id: true } });
      let eligible = 0;
      for (const user of users) if ((await explainWelcomeEligibility(user.id, input.localDate, { db: deps.db, now: deps.now })).eligible) eligible += 1;
      if (input.displayedRecipientCount !== eligible) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "页面人数已变化，请刷新后重试");
      if (eligible > deps.bulkThreshold) verifyMailConfirmationToken(input.confirmationToken, {
        action: "ENQUEUE_TODAY", localDate: input.localDate, count: eligible,
      }, { secret: deps.bulkConfirmationSecret, now: deps.now() });
      const summary = await enqueueDueWelcomeMail(input.localDate, snapshotUserIdentity(actor), {
        db: deps.db, now: deps.now, bulkConfirmThreshold: deps.bulkThreshold, confirmBulk: true,
        expectedEligibleCount: eligible,
      });
      return NextResponse.json({ ok: true, summary }, { status: 201 });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
export async function POST(request: Request) {
  const env = getEnv();
  return createOnboardingMailEnqueueTodayRoute({
    db: prisma,
    now: () => new Date(),
    bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
    bulkThreshold: env.ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD,
  }).POST(request);
}

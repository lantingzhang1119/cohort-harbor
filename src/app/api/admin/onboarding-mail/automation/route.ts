import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { assertAutomationEnablePreconditions, MailAdminError, verifyMailConfirmationToken } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { explainWelcomeEligibility, shanghaiCalendarDate, shanghaiDateRange } from "@/features/onboarding-mail/eligibility-service";
import { setWelcomeMailAutomationEnabled } from "@/features/onboarding-mail/scheduler";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const inputSchema = z.object({
  enabled: z.boolean(),
  confirmed: z.boolean(),
  displayedRecipientCount: z.number().int().nonnegative(),
  confirmationToken: z.string().min(1).optional(),
});

type Dependencies = {
  db: PrismaClient;
  now: () => Date;
  bulkConfirmationSecret: string;
  smtpTestMaxAgeMs: number;
};

export function createOnboardingMailAutomationRoute(dependencies: Dependencies) {
  return {
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(dependencies.db, request);
        const input = inputSchema.parse(await request.json());
        if (!input.confirmed) throw new Error("请确认页面显示的收件人数");
        if (input.enabled) {
          await assertAutomationEnablePreconditions(dependencies.db, { now: dependencies.now(), smtpTestMaxAgeMs: dependencies.smtpTestMaxAgeMs });
          const localDate = shanghaiCalendarDate(dependencies.now());
          const { start, end } = shanghaiDateRange(localDate);
          const users = await dependencies.db.user.findMany({ where: { hiredAt: { gte: start, lt: end } }, select: { id: true } });
          let eligible = 0;
          for (const user of users) if ((await explainWelcomeEligibility(user.id, localDate, {
            db: dependencies.db,
            now: dependencies.now,
            prospectiveAutomationEnabledAt: dependencies.now(),
          })).eligible) eligible += 1;
          if (input.displayedRecipientCount !== eligible) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "页面人数已变化，请刷新后重试");
          verifyMailConfirmationToken(input.confirmationToken, { action: "ENABLE_AUTOMATION", localDate, count: eligible }, {
            secret: dependencies.bulkConfirmationSecret, now: dependencies.now(),
          });
        }
        const setting = await setWelcomeMailAutomationEnabled(input.enabled, actor.id, {
          db: dependencies.db,
          now: dependencies.now,
        });
        return NextResponse.json({
          ok: true,
          automation: {
            enabled: setting.onboardingMailAutomationEnabled,
            enabledAt: setting.onboardingMailAutomationEnabledAt,
          },
        });
      } catch (error) {
        return onboardingMailErrorResponse(error);
      }
    },
  };
}

export async function PATCH(request: Request) {
  const env = getEnv();
  return createOnboardingMailAutomationRoute({
    db: prisma,
    now: () => new Date(),
    bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
    smtpTestMaxAgeMs: 15 * 60_000,
  }).PATCH(request);
}

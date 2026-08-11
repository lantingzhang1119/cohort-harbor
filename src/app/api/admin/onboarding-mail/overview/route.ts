import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { createMailConfirmationToken } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { explainWelcomeEligibility, shanghaiCalendarDate, shanghaiDateRange } from "@/features/onboarding-mail/eligibility-service";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const reasonLabels: Record<string, string> = {
  NO_EMAIL: "缺少邮箱",
  USER_NOT_EMPLOYEE: "仅在职员工可收件",
  USER_DISABLED: "账号已停用",
  USER_INACTIVE: "员工状态非在职",
  AUTOMATION_OFF: "自动发送未启用",
  TEMPLATE_DISABLED: "模板未启用或未发布",
  MISSING_REQUIRED_FIELD: "缺少必填字段",
  ALREADY_SENT: "当日邮件已发送",
  DATE_MISMATCH: "入职日期不匹配",
  DATE_BEFORE_AUTOMATION_FLOOR: "早于自动发送启用日期",
  LOOKBACK_EXCEEDED: "超出自动发送回看范围",
};

type Dependencies = {
  db: PrismaClient;
  now: () => Date;
  bulkConfirmationSecret: string;
  smtpConfigured: boolean;
};

export function createOnboardingMailOverviewRoute(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(dependencies.db, request);
        const localDate = shanghaiCalendarDate(dependencies.now());
        const { start, end } = shanghaiDateRange(localDate);
        const candidates = await dependencies.db.user.findMany({
          where: { hiredAt: { gte: start, lt: end } },
          select: { id: true, employeeNo: true, name: true, email: true },
          orderBy: { employeeNo: "asc" },
        });
        const diagnostics = await Promise.all(candidates.map(async (candidate) => {
          const result = await explainWelcomeEligibility(candidate.id, localDate, { db: dependencies.db, now: dependencies.now });
          return { ...candidate, ...result, ...(!result.eligible ? { reasonLabel: reasonLabels[result.reason] ?? result.reason } : {}) };
        }));
        const prospectiveDiagnostics = await Promise.all(candidates.map((candidate) => explainWelcomeEligibility(candidate.id, localDate, {
          db: dependencies.db,
          now: dependencies.now,
          prospectiveAutomationEnabledAt: dependencies.now(),
        })));
        const prospectiveEligible = prospectiveDiagnostics.filter((item) => item.eligible).length;
        const pastCandidates = await dependencies.db.user.findMany({
          where: {
            role: Role.EMPLOYEE,
            hiredAt: { gte: new Date(start.getTime() - 30 * 86_400_000), lt: start },
            email: { not: null },
            enabled: true,
            status: "ACTIVE",
            mailDeliveryRecipients: {
              none: { status: { in: ["SENT", "UNKNOWN"] } },
            },
          },
          select: { id: true, employeeNo: true, name: true, hiredAt: true },
          orderBy: [{ hiredAt: "desc" }, { employeeNo: "asc" }],
          take: 101,
        });
        const pastMissedRows = pastCandidates.map((item) => ({
          id: item.id,
          employeeNo: item.employeeNo,
          name: item.name,
          localDate: shanghaiCalendarDate(item.hiredAt!),
          reasonLabel: "历史未发送，可手动处理",
          selected: false,
        }));
        const pastMissed = pastMissedRows.slice(0, 100);
        const eligible = diagnostics.filter((item) => item.eligible).length;
        const enableAutomation = createMailConfirmationToken({ action: "ENABLE_AUTOMATION", localDate, count: prospectiveEligible }, {
          secret: dependencies.bulkConfirmationSecret, now: dependencies.now(),
        });
        const enqueueToday = createMailConfirmationToken({ action: "ENQUEUE_TODAY", localDate, count: eligible }, {
          secret: dependencies.bulkConfirmationSecret, now: dependencies.now(),
        });
        const [setting, lastSuccessfulSmtpTest] = await Promise.all([
          dependencies.db.systemSetting.findUnique({ where: { id: "default" } }),
          dependencies.db.auditLog.findFirst({ where: { action: "ONBOARDING_MAIL_SMTP_TEST", result: "SUCCESS" }, select: { createdAt: true }, orderBy: { createdAt: "desc" } }),
        ]);
        return NextResponse.json({
          ok: true,
          smtp: { configured: dependencies.smtpConfigured, lastSuccessfulTestAt: lastSuccessfulSmtpTest?.createdAt ?? null },
          automation: {
            enabled: setting?.onboardingMailAutomationEnabled ?? false,
            enabledAt: setting?.onboardingMailAutomationEnabledAt ?? null,
            confirmRecipientCount: prospectiveEligible,
          },
          today: {
            localDate,
            matched: candidates.length,
            eligible,
            excluded: candidates.length - eligible,
            employees: diagnostics,
          },
          confirmations: { enableAutomation, enqueueToday },
          pastMissed,
          truncation: { pastMissed: { limit: 100, truncated: pastMissedRows.length > 100 } },
        });
      } catch (error) {
        return onboardingMailErrorResponse(error);
      }
    },
  };
}

export async function GET(request: Request) {
  const env = getEnv();
  return createOnboardingMailOverviewRoute({
    db: prisma,
    now: () => new Date(),
    bulkConfirmationSecret: env.ONBOARDING_MAIL_CONFIRMATION_SECRET,
    smtpConfigured: Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && env.SMTP_FROM),
  }).GET(request);
}

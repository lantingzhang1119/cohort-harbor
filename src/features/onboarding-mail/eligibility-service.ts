import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliveryStatus, OnboardingMailTemplateKind, Role, UserStatus } from "@/generated/prisma/enums";
import { FieldRegistryError, resolveMailFields, validateFieldConfig, type MailFieldConfig } from "@/features/onboarding-mail/field-registry";
import { prisma } from "@/lib/db/client";

export type WelcomeEligibilityReason =
  | "NO_EMAIL"
  | "USER_NOT_EMPLOYEE"
  | "USER_DISABLED"
  | "USER_INACTIVE"
  | "AUTOMATION_OFF"
  | "TEMPLATE_DISABLED"
  | "MISSING_REQUIRED_FIELD"
  | "ALREADY_SENT"
  | "DATE_MISMATCH"
  | "DATE_BEFORE_AUTOMATION_FLOOR"
  | "LOOKBACK_EXCEEDED";

export type WelcomeEligibility =
  | { eligible: true; reason: null; templateRevisionId: string }
  | { eligible: false; reason: WelcomeEligibilityReason; templateRevisionId?: string };

type EligibilityOptions = {
  db?: PrismaClient;
  now?: () => Date;
  lookbackDays?: number;
  companyName?: string;
  prospectiveAutomationEnabledAt?: Date;
};

export function shanghaiDateRange(localDate: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new TypeError("本地日期必须是 YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  const nominal = new Date(Date.UTC(year, month - 1, day));
  if (nominal.getUTCFullYear() !== year || nominal.getUTCMonth() !== month - 1 || nominal.getUTCDate() !== day) {
    throw new TypeError("本地日期无效");
  }
  const start = new Date(nominal.getTime() - 8 * 60 * 60 * 1_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function shanghaiCalendarDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function validatedWelcomeMailLookbackDays(value: number | undefined): number {
  const lookbackDays = value ?? 1;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 7) {
    throw new RangeError("lookbackDays 必须在 0..7 范围内");
  }
  return lookbackDays;
}

export async function findQualifiedWelcomeMailRecipientIdsForDate(
  db: Pick<PrismaClient, "user">,
  userIds: string[],
  localDate: string,
): Promise<string[]> {
  const { start, end } = shanghaiDateRange(localDate);
  const users = await db.user.findMany({
    where: {
      id: { in: [...new Set(userIds)] },
      role: Role.EMPLOYEE,
      enabled: true,
      status: UserStatus.ACTIVE,
      hiredAt: { gte: start, lt: end },
      email: { not: null },
    },
    select: { id: true, email: true },
  });
  return users.filter((user) => Boolean(user.email?.trim())).map((user) => user.id);
}

function daysBefore(referenceDate: string, targetDate: string): number {
  const reference = shanghaiDateRange(referenceDate).start.getTime();
  const target = shanghaiDateRange(targetDate).start.getTime();
  return Math.floor((reference - target) / 86_400_000);
}

export async function explainWelcomeEligibility(
  userId: string,
  localDate: string,
  options: EligibilityOptions = {},
): Promise<WelcomeEligibility> {
  const db = options.db ?? prisma;
  const lookbackDays = validatedWelcomeMailLookbackDays(options.lookbackDays);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.email?.trim()) return { eligible: false, reason: "NO_EMAIL" };
  if (user.role !== Role.EMPLOYEE) return { eligible: false, reason: "USER_NOT_EMPLOYEE" };
  if (!user.enabled) return { eligible: false, reason: "USER_DISABLED" };
  if (user.status !== UserStatus.ACTIVE) return { eligible: false, reason: "USER_INACTIVE" };

  const setting = await db.systemSetting.findUnique({ where: { id: "default" } });
  const automationEnabledAt = setting?.onboardingMailAutomationEnabled && setting.onboardingMailAutomationEnabledAt
    ? setting.onboardingMailAutomationEnabledAt
    : options.prospectiveAutomationEnabledAt;
  if (!automationEnabledAt) {
    return { eligible: false, reason: "AUTOMATION_OFF" };
  }
  const template = await db.onboardingMailTemplate.findUnique({
    where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
    include: { currentRevision: true },
  });
  if (!template?.enabled || !template.currentRevision) return { eligible: false, reason: "TEMPLATE_DISABLED" };

  const floorDate = shanghaiCalendarDate(automationEnabledAt);
  if (localDate < floorDate) return { eligible: false, reason: "DATE_BEFORE_AUTOMATION_FLOOR", templateRevisionId: template.currentRevision.id };
  if (daysBefore(shanghaiCalendarDate((options.now ?? (() => new Date()))()), localDate) > lookbackDays) {
    return { eligible: false, reason: "LOOKBACK_EXCEEDED", templateRevisionId: template.currentRevision.id };
  }
  const { start, end } = shanghaiDateRange(localDate);
  if (!user.hiredAt || user.hiredAt < start || user.hiredAt >= end) {
    return { eligible: false, reason: "DATE_MISMATCH", templateRevisionId: template.currentRevision.id };
  }
  try {
    const config = validateFieldConfig(template.currentRevision.fieldConfig as unknown as MailFieldConfig[]);
    resolveMailFields(config, user, { companyName: options.companyName ?? "", now: options.now?.() });
  } catch (error) {
    if (error instanceof FieldRegistryError && error.code === "MISSING_REQUIRED_FIELD") {
      return { eligible: false, reason: "MISSING_REQUIRED_FIELD", templateRevisionId: template.currentRevision.id };
    }
    throw error;
  }
  const isolated = await db.onboardingMailDelivery.findFirst({
    where: {
      recipientId: userId,
      status: { in: [OnboardingMailDeliveryStatus.SENT, OnboardingMailDeliveryStatus.UNKNOWN] },
    },
    select: { id: true },
  });
  if (isolated) return { eligible: false, reason: "ALREADY_SENT", templateRevisionId: template.currentRevision.id };
  return { eligible: true, reason: null, templateRevisionId: template.currentRevision.id };
}

import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
} from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { renderWelcomeTemplate } from "@/features/onboarding-mail/template-service";

export type ConfirmationAction = "ENABLE_AUTOMATION" | "ENQUEUE_TODAY" | "MANUAL_SEND" | "RESEND";

type ConfirmationPayload = {
  action: ConfirmationAction;
  localDate: string;
  count: number;
  selectionDigest?: string;
  expiresAt: number;
};

export class MailAdminError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "MailAdminError";
  }
}

function signature(encoded: string, secret: string) {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function createMailConfirmationToken(
  input: Omit<ConfirmationPayload, "expiresAt">,
  options: { secret: string; now: Date; ttlMs?: number },
) {
  const payload: ConfirmationPayload = {
    ...input,
    expiresAt: options.now.getTime() + (options.ttlMs ?? 5 * 60_000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${signature(encoded, options.secret)}`, expiresAt: new Date(payload.expiresAt) };
}

export function mailSelectionDigest(ids: string[]) {
  return createHash("sha256").update([...new Set(ids)].sort().join("\n")).digest("base64url");
}

export function verifyMailConfirmationToken(
  token: string | undefined,
  expected: Omit<ConfirmationPayload, "expiresAt">,
  options: { secret: string; now: Date },
) {
  if (!token) throw new MailAdminError("BULK_CONFIRMATION_REQUIRED", 409, "需要有效的收件人数确认");
  const [encoded, provided, extra] = token.split(".");
  if (!encoded || !provided || extra) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "确认信息与当前操作不匹配");
  const expectedSignature = signature(encoded, options.secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "确认信息与当前操作不匹配");
  }
  let payload: ConfirmationPayload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ConfirmationPayload; }
  catch { throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "确认信息与当前操作不匹配"); }
  if (
    payload.action !== expected.action
    || payload.localDate !== expected.localDate
    || payload.count !== expected.count
    || payload.selectionDigest !== expected.selectionDigest
    || !Number.isSafeInteger(payload.expiresAt)
  ) throw new MailAdminError("CONFIRMATION_MISMATCH", 409, "确认信息与当前操作不匹配");
  if (payload.expiresAt < options.now.getTime()) {
    throw new MailAdminError("CONFIRMATION_EXPIRED", 409, "确认已过期，请刷新人数后重试");
  }
}

export async function assertAutomationEnablePreconditions(
  db: PrismaClient,
  options: { now: Date; smtpTestMaxAgeMs: number },
) {
  const smtpTest = await db.auditLog.findFirst({
    where: {
      action: "ONBOARDING_MAIL_SMTP_TEST",
      result: "SUCCESS",
      createdAt: { gte: new Date(options.now.getTime() - options.smtpTestMaxAgeMs) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!smtpTest) throw new MailAdminError("SMTP_TEST_REQUIRED", 409, "请先完成最近一次 SMTP 连接测试");
  const template = await db.onboardingMailTemplate.findUnique({
    where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
    include: { currentRevision: true },
  });
  if (!template?.enabled || !template.currentRevision) {
    throw new MailAdminError("PUBLISHED_TEMPLATE_REQUIRED", 409, "请先启用并发布有效的欢迎邮件模板");
  }
  return template;
}

export async function createExplicitTestDelivery(input: {
  db: PrismaClient;
  actorId: string;
  employeeId: string;
  templateRevisionId: string;
  testMailbox: string;
  now: Date;
}) {
  const [actor, rendered] = await Promise.all([
    input.db.user.findUniqueOrThrow({ where: { id: input.actorId } }),
    renderWelcomeTemplate(input.templateRevisionId, input.employeeId, { db: input.db, now: input.now }),
  ]);
  return input.db.onboardingMailDelivery.create({ data: {
    source: OnboardingMailDeliverySource.TEST,
    recipientId: null,
    recipientEmailSnapshot: input.testMailbox,
    recipientSnapshot: { kind: "EXPLICIT_TEST_MAILBOX", mailbox: input.testMailbox },
    templateRevisionId: input.templateRevisionId,
    templateSnapshot: {
      senderDisplayName: rendered.senderDisplayName,
      subject: `[测试邮件] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    },
    fieldSummary: rendered.fields as Prisma.InputJsonValue,
    ccSnapshot: [],
    attachmentSummary: rendered.attachments.map((attachment) => ({
      role: attachment.role,
      fileAssetId: attachment.fileAssetId,
      materialVersionId: attachment.materialVersionId,
      displayName: attachment.displayName,
      contentId: attachment.contentId,
    })) as Prisma.InputJsonValue,
    scheduledLocalDate: null,
    scheduledAt: input.now,
    actorId: actor.id,
    actorSnapshot: snapshotUserIdentity(actor),
  } });
}

export async function retryFailedDeliveries(
  db: PrismaClient,
  deliveryIds: string[],
  now: Date,
) {
  const ids = [...new Set(deliveryIds)];
  const rows = await db.onboardingMailDelivery.findMany({ where: { id: { in: ids } } });
  if (rows.some((row) => row.status === OnboardingMailDeliveryStatus.UNKNOWN)) {
    throw new MailAdminError("UNKNOWN_NOT_RETRYABLE", 400, "结果未确认的投递不能批量重试，请逐条人工解决");
  }
  if (rows.length !== ids.length || rows.some((row) => row.status !== OnboardingMailDeliveryStatus.FAILED)) {
    throw new MailAdminError("DELIVERY_NOT_RETRYABLE", 400, "只能重试失败的投递");
  }
  return db.onboardingMailDelivery.updateMany({
    where: { id: { in: ids }, status: OnboardingMailDeliveryStatus.FAILED },
    data: {
      status: OnboardingMailDeliveryStatus.PENDING,
      scheduledAt: now,
      retryable: false,
      nextRetryAt: null,
      failureCode: null,
      errorSummary: null,
    },
  });
}

import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  OnboardingMailAttachmentRole,
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailUnknownResolution,
  Role,
  UserStatus,
} from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import type { SmtpOutcome, SmtpMessage } from "@/features/mail/smtp-transport";
import { verifyPersistedMailAsset } from "@/features/onboarding-mail/asset-service";
import { resolveCcRecipients } from "@/features/onboarding-mail/cc-service";
import { explainWelcomeEligibility, validatedWelcomeMailLookbackDays } from "@/features/onboarding-mail/eligibility-service";
import { assertMailMessageSize } from "@/features/onboarding-mail/message-size";
import { renderWelcomeTemplate } from "@/features/onboarding-mail/template-service";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export type CreateWelcomeDeliveryInput = {
  source: OnboardingMailDeliverySource;
  recipientId: string;
  templateRevisionId: string;
  scheduledLocalDate: string | null;
  scheduledAt: Date;
  actorId?: string | null;
  actorSnapshot?: Prisma.InputJsonObject | null;
  resendOfId?: string | null;
};

export type WelcomeMailDb = PrismaClient | Prisma.TransactionClient;
type CommonOptions = { db?: WelcomeMailDb; now?: () => Date; companyName?: string; privateRoot?: string };
type ClientOptions = Omit<CommonOptions, "db"> & { db?: PrismaClient };

export type ClaimOptions = ClientOptions & {
  batchSize?: number;
  leaseDurationMs?: number;
  transportHardTimeoutMs?: number;
  safetyMarginMs?: number;
};

export type ClaimedDelivery = Awaited<ReturnType<PrismaClient["onboardingMailDelivery"]["findUniqueOrThrow"]>>;

export type DeliveryResult = {
  id: string;
  status: OnboardingMailDeliveryStatus | "STALE" | "ACCEPTED_STALE";
  outcome?: SmtpOutcome;
};

export type DeliveryTransport = {
  send(message: SmtpMessage): Promise<SmtpOutcome>;
  isUsable?(): boolean;
  close?(): void | Promise<void>;
};

export type ProcessOptions = ClientOptions & {
  transport: DeliveryTransport;
  leaseDurationMs?: number;
  retryLimit?: number;
  retryBaseMs?: number;
  lookbackDays?: number;
  rawAttachmentMaxBytes?: number;
  encodedMimeMaxBytes?: number;
  attachmentCache?: MailAttachmentCache;
};

const DEFAULT_MAIL_ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;

export class MailAttachmentCache {
  readonly #entries = new Map<string, Promise<SmtpMessage["attachments"]>>();
  readonly #entrySizes = new Map<string, number>();
  #retainedBytes = 0;

  constructor(readonly maxRetainedBytes = DEFAULT_MAIL_ATTACHMENT_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
      throw new RangeError("maxRetainedBytes must be a positive integer");
    }
  }

  get size() { return this.#entries.size; }
  get(key: string) { return this.#entries.get(key); }
  setPending(key: string, pending: Promise<SmtpMessage["attachments"]>) { this.#entries.set(key, pending); }

  reject(key: string, pending: Promise<SmtpMessage["attachments"]>) {
    if (this.#entries.get(key) === pending) this.#entries.delete(key);
  }

  retain(key: string, pending: Promise<SmtpMessage["attachments"]>, attachments: SmtpMessage["attachments"]) {
    if (this.#entries.get(key) !== pending) return;
    if (this.#entrySizes.has(key)) return;
    const sizeBytes = attachments.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
    if (sizeBytes > this.maxRetainedBytes) {
      this.#entries.delete(key);
      return;
    }
    while (this.#retainedBytes + sizeBytes > this.maxRetainedBytes) {
      const oldest = this.#entrySizes.entries().next().value as [string, number] | undefined;
      if (!oldest) {
        this.#entries.delete(key);
        return;
      }
      this.#entrySizes.delete(oldest[0]);
      this.#entries.delete(oldest[0]);
      this.#retainedBytes -= oldest[1];
    }
    this.#entrySizes.set(key, sizeBytes);
    this.#retainedBytes += sizeBytes;
  }
}

export function createMailAttachmentCache(options: { maxRetainedBytes?: number } = {}): MailAttachmentCache {
  return new MailAttachmentCache(options.maxRetainedBytes);
}

type TemplateSnapshot = { senderDisplayName: string; subject: string; html: string; text: string };

function automaticKey(source: OnboardingMailDeliverySource, recipientId: string, localDate: string | null) {
  if (source !== OnboardingMailDeliverySource.AUTOMATIC) return null;
  if (!localDate) throw new TypeError("自动邮件必须有本地计划日期");
  return `welcome:${recipientId}:${localDate}`;
}

export async function createWelcomeDelivery(
  input: CreateWelcomeDeliveryInput,
  options: CommonOptions = {},
) {
  const db = options.db ?? prisma;
  const data = await prepareWelcomeDeliveryData(input, { ...options, db });
  return db.onboardingMailDelivery.create({ data });
}

export async function prepareWelcomeDeliveryData(
  input: CreateWelcomeDeliveryInput,
  options: CommonOptions = {},
): Promise<Prisma.OnboardingMailDeliveryUncheckedCreateInput> {
  const db = options.db ?? prisma;
  const queryDb = db as PrismaClient;
  const [recipient, revision, rendered] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: input.recipientId } }),
    db.onboardingMailTemplateRevision.findUniqueOrThrow({
      where: { id: input.templateRevisionId }, include: { attachments: true, ccEntries: true },
    }),
    renderWelcomeTemplate(input.templateRevisionId, input.recipientId, {
      db: queryDb, companyName: options.companyName ?? "", now: options.now?.(),
    }),
  ]);
  const cc = await resolveCcRecipients(rendered.ccEntries.map((entry) => entry.kind === "USER"
    ? { kind: "USER", userId: entry.userId!, displayName: entry.displayName, sortOrder: entry.sortOrder }
    : { kind: "EMAIL", email: entry.email!, displayName: entry.displayName, sortOrder: entry.sortOrder }), rendered.recipient, { db: queryDb });
  return {
    source: input.source,
    idempotencyKey: automaticKey(input.source, input.recipientId, input.scheduledLocalDate),
    recipientId: input.recipientId,
    recipientEmailSnapshot: rendered.recipient.email,
    recipientSnapshot: snapshotUserIdentity(recipient),
    templateRevisionId: input.templateRevisionId,
    templateSnapshot: {
      senderDisplayName: rendered.senderDisplayName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      revisionNumber: revision.revisionNumber,
    },
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
    scheduledLocalDate: input.scheduledLocalDate,
    scheduledAt: input.scheduledAt,
    actorId: input.actorId ?? null,
    actorSnapshot: input.actorSnapshot ?? undefined,
    resendOfId: input.resendOfId ?? null,
  };
}

function assertLease(options: ClaimOptions) {
  const leaseDurationMs = options.leaseDurationMs ?? 180_000;
  const transportHardTimeoutMs = options.transportHardTimeoutMs ?? 120_000;
  const safetyMarginMs = options.safetyMarginMs ?? 30_000;
  if (leaseDurationMs < transportHardTimeoutMs + safetyMarginMs) {
    throw new RangeError("邮件租约时长必须不小于传输硬超时与安全余量之和");
  }
  return leaseDurationMs;
}

export async function claimDueDeliveries(
  workerId: string,
  now: Date,
  options: ClaimOptions = {},
): Promise<ClaimedDelivery[]> {
  if (!workerId.trim()) throw new TypeError("workerId 不能为空");
  const db = options.db ?? prisma;
  const leaseDurationMs = assertLease(options);
  const batchSize = options.batchSize ?? 20;
  return db.$transaction(async (transaction) => {
    await transaction.onboardingMailDelivery.updateMany({
      where: {
        status: OnboardingMailDeliveryStatus.SENDING,
        leaseExpiresAt: { lte: now },
        dispatchedAt: { not: null },
      },
      data: {
        status: OnboardingMailDeliveryStatus.UNKNOWN,
        retryable: false,
        nextRetryAt: null,
        workerId: null,
        leaseExpiresAt: null,
        failureCode: "LEASE_EXPIRED_AFTER_DISPATCH",
        errorSummary: "投递后租约失效，结果不确定，禁止自动重发",
      },
    });
    const expiredUndispatchedWhere = {
      status: OnboardingMailDeliveryStatus.SENDING,
      leaseExpiresAt: { lte: now },
      dispatchedAt: null,
    } as const;
    await transaction.onboardingMailDelivery.updateMany({
      where: {
        ...expiredUndispatchedWhere,
        attemptCount: { gt: 0 },
      },
      data: {
        status: OnboardingMailDeliveryStatus.PENDING,
        attemptCount: { decrement: 1 },
        workerId: null,
        leaseExpiresAt: null,
        retryable: false,
        failureCode: "LEASE_RECOVERED_BEFORE_DISPATCH",
        errorSummary: "发送前租约失效，已安全恢复",
      },
    });
    await transaction.onboardingMailDelivery.updateMany({
      where: expiredUndispatchedWhere,
      data: {
        status: OnboardingMailDeliveryStatus.PENDING,
        attemptCount: 0,
        workerId: null,
        leaseExpiresAt: null,
        retryable: false,
        failureCode: "LEASE_RECOVERED_BEFORE_DISPATCH",
        errorSummary: "发送前租约失效，已安全恢复",
      },
    });
    const due = await transaction.onboardingMailDelivery.findMany({
      where: {
        OR: [
          { status: OnboardingMailDeliveryStatus.PENDING, scheduledAt: { lte: now } },
          { status: OnboardingMailDeliveryStatus.FAILED, retryable: true, nextRetryAt: { lte: now } },
        ],
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      take: batchSize,
    });
    const claimed: ClaimedDelivery[] = [];
    for (const candidate of due) {
      const updated = await transaction.onboardingMailDelivery.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          leaseGeneration: candidate.leaseGeneration,
          workerId: candidate.workerId,
        },
        data: {
          status: OnboardingMailDeliveryStatus.SENDING,
          workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
          leaseGeneration: { increment: 1 },
          attemptCount: { increment: 1 },
          startedAt: now,
          dispatchedAt: null,
          retryable: false,
          nextRetryAt: null,
          failureCode: null,
          errorSummary: null,
          providerMessageId: null,
          responseSummary: null,
        },
      });
      if (updated.count === 1) claimed.push(await transaction.onboardingMailDelivery.findUniqueOrThrow({ where: { id: candidate.id } }));
    }
    return claimed;
  });
}

type UndispatchedClaimRef = Pick<ClaimedDelivery, "id" | "leaseGeneration">;

export async function renewUndispatchedDeliveryClaims(
  workerId: string,
  claims: UndispatchedClaimRef[],
  leaseExpiresAt: Date,
  options: { db?: PrismaClient } = {},
): Promise<number> {
  if (claims.length === 0) return 0;
  const db = options.db ?? prisma;
  const updated = await db.onboardingMailDelivery.updateMany({
    where: {
      status: OnboardingMailDeliveryStatus.SENDING,
      workerId,
      dispatchedAt: null,
      OR: claims.map((claim) => ({ id: claim.id, leaseGeneration: claim.leaseGeneration })),
    },
    data: { leaseExpiresAt },
  });
  return updated.count;
}

export async function releaseUndispatchedDeliveryClaims(
  workerId: string,
  claims: UndispatchedClaimRef[],
  options: { db?: PrismaClient } = {},
): Promise<number> {
  if (claims.length === 0) return 0;
  const db = options.db ?? prisma;
  const claimWhere = {
    status: OnboardingMailDeliveryStatus.SENDING,
    workerId,
    dispatchedAt: null,
    OR: claims.map((claim) => ({ id: claim.id, leaseGeneration: claim.leaseGeneration })),
  } as const;
  const releasedData = {
    status: OnboardingMailDeliveryStatus.PENDING,
    startedAt: null,
    workerId: null,
    leaseExpiresAt: null,
    retryable: false,
    nextRetryAt: null,
    failureCode: "SMTP_TRANSPORT_UNUSABLE_BATCH_RELEASE",
    errorSummary: "SMTP transport unavailable; undispatched batch item released",
  } satisfies Prisma.OnboardingMailDeliveryUpdateManyMutationInput;
  const decremented = await db.onboardingMailDelivery.updateMany({
    where: {
      ...claimWhere,
      attemptCount: { gt: 0 },
    },
    data: {
      ...releasedData,
      attemptCount: { decrement: 1 },
    },
  });
  const clamped = await db.onboardingMailDelivery.updateMany({
    where: claimWhere,
    data: { ...releasedData, attemptCount: 0 },
  });
  return decremented.count + clamped.count;
}

async function cancelClaim(db: PrismaClient, delivery: ClaimedDelivery, workerId: string, reason: string): Promise<DeliveryResult> {
  const result = await db.onboardingMailDelivery.updateMany({
    where: {
      id: delivery.id,
      status: OnboardingMailDeliveryStatus.SENDING,
      workerId,
      leaseGeneration: delivery.leaseGeneration,
      dispatchedAt: null,
    },
    data: {
      status: OnboardingMailDeliveryStatus.CANCELLED,
      retryable: false,
      workerId: null,
      leaseExpiresAt: null,
      failureCode: reason,
      errorSummary: "发送前资格复核未通过",
    },
  });
  return { id: delivery.id, status: result.count === 1 ? OnboardingMailDeliveryStatus.CANCELLED : "STALE" };
}

async function automaticEligibility(db: PrismaClient, delivery: ClaimedDelivery, now: () => Date, lookbackDays: number) {
  if (delivery.source !== OnboardingMailDeliverySource.AUTOMATIC) return null;
  if (!delivery.recipientId || !delivery.scheduledLocalDate) return "DATE_MISMATCH";
  const result = await explainWelcomeEligibility(delivery.recipientId, delivery.scheduledLocalDate, { db, now, lookbackDays });
  return result.eligible ? null : result.reason;
}

async function currentRecipientEligibility(db: PrismaClient, delivery: ClaimedDelivery) {
  if (!delivery.recipientId) return null;
  const recipient = await db.user.findUnique({
    where: { id: delivery.recipientId },
    select: { email: true, role: true, enabled: true, status: true },
  });
  if (!recipient?.email?.trim()) return "NO_EMAIL";
  if (recipient.role !== Role.EMPLOYEE) return "USER_NOT_EMPLOYEE";
  if (!recipient.enabled) return "USER_DISABLED";
  if (recipient.status !== UserStatus.ACTIVE) return "USER_INACTIVE";
  if (recipient.email !== delivery.recipientEmailSnapshot) return "RECIPIENT_EMAIL_CHANGED";
  return null;
}

function attachmentCacheKey(
  revisionId: string,
  privateRoot: string,
  rows: Awaited<ReturnType<PrismaClient["onboardingMailRevisionAttachment"]["findMany"]>>,
) {
  return JSON.stringify([
    revisionId,
    privateRoot,
    ...rows.map((row) => {
      const item = row as typeof row & {
        fileAsset: { id: string; storageKey: string; sha256: string; sizeBytes: number } | null;
        materialVersion: { fileAsset: { id: string; storageKey: string; sha256: string; sizeBytes: number } } | null;
      };
      const asset = item.fileAsset ?? item.materialVersion?.fileAsset;
      return [row.id, row.role, row.contentId, asset?.id, asset?.storageKey, asset?.sha256, asset?.sizeBytes];
    }),
  ]);
}

export async function loadVerifiedRevisionAttachments(
  db: PrismaClient,
  revisionId: string,
  privateRoot: string,
  cache?: MailAttachmentCache,
) {
  const rows = await db.onboardingMailRevisionAttachment.findMany({
    where: { revisionId },
    include: { fileAsset: true, materialVersion: { include: { fileAsset: true } } },
    orderBy: { sortOrder: "asc" },
  });
  if (rows.length > 100) throw new Error("冻结附件数量超过 100 项");
  const normalizedRows = rows.map((row) => {
    const displayName = row.displayName.trim();
    if (!displayName || displayName.length > 240 || /[\r\n]/.test(displayName)) {
      throw new Error("冻结附件名称无效或超过 240 个字符");
    }
    if (row.role === OnboardingMailAttachmentRole.ATTACHMENT) {
      if (row.contentId) throw new Error("普通冻结附件不能包含 Content-ID");
    } else if (!row.contentId || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,126}$/.test(row.contentId)) {
      throw new Error("冻结内嵌附件 Content-ID 无效");
    }
    return { ...row, displayName };
  });
  const key = attachmentCacheKey(revisionId, privateRoot, normalizedRows);
  const existing = cache?.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const attachments: SmtpMessage["attachments"] = [];
    for (const row of normalizedRows) {
      const asset = row.fileAsset ?? row.materialVersion?.fileAsset;
      if (!asset) throw new Error("冻结附件资源不存在");
      const bytes = await verifyPersistedMailAsset(asset, { role: row.role, contentId: row.contentId }, { privateRoot });
      attachments.push({
        fileName: row.displayName,
        mimeType: asset.mimeType,
        bytes,
        ...(row.role !== OnboardingMailAttachmentRole.ATTACHMENT && row.contentId ? { contentId: row.contentId } : {}),
      });
    }
    return attachments;
  })();
  cache?.setPending(key, pending);
  try {
    const attachments = await pending;
    cache?.retain(key, pending, attachments);
    return attachments;
  } catch (error) {
    cache?.reject(key, pending);
    throw error;
  }
}

function parseSnapshot(value: Prisma.JsonValue): TemplateSnapshot {
  const snapshot = value as unknown as Partial<TemplateSnapshot>;
  if (![snapshot.senderDisplayName, snapshot.subject, snapshot.html, snapshot.text].every((item) => typeof item === "string")) {
    throw new Error("冻结模板快照无效");
  }
  const senderDisplayName = snapshot.senderDisplayName!.trim();
  const subject = snapshot.subject!.trim();
  if (!senderDisplayName || senderDisplayName.length > 120 || /[\r\n]/.test(senderDisplayName)) {
    throw new Error("冻结模板发件人无效或超过 120 个字符");
  }
  if (!subject || subject.length > 500 || /[\r\n]/.test(subject)) {
    throw new Error("冻结模板主题无效或超过 500 个字符");
  }
  if (!snapshot.html || snapshot.html.length > 1_000_000 || snapshot.text!.length > 1_000_000) {
    throw new Error("冻结模板正文无效或超过 1000000 个字符");
  }
  return { senderDisplayName, subject, html: snapshot.html, text: snapshot.text! };
}

function parseCc(value: Prisma.JsonValue): Array<{ email: string; displayName?: string | null }> {
  if (!Array.isArray(value)) throw new Error("冻结抄送快照无效");
  if (value.length > 100) throw new Error("冻结抄送快照超过 100 项");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.email !== "string") throw new Error("冻结抄送快照无效");
    const email = item.email.trim();
    if (!email || email.length > 254 || /[\r\n]/.test(email)) throw new Error("冻结抄送邮箱无效");
    const displayName = typeof item.displayName === "string" ? item.displayName.trim() : null;
    if (displayName && displayName.length > 120) throw new Error("冻结抄送显示名超过 120 个字符");
    return { email, displayName };
  });
}

export function sanitizeMailErrorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : typeof error === "string" ? error : "发送失败")
    .replace(/(smtps?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(["']?(?:(?:smtp|api|auth)[_-]?)?(?:password|passwd|pwd|token|secret|authorization|auth)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}\]]+)/gi, "$1[redacted]")
    .slice(0, 500);
}

function protocolResponseSummary(summary: string | null, stage: SmtpOutcome["protocolStage"]): string {
  return `${summary ? `${summary}; ` : ""}protocolStage=${stage}`.slice(0, 500);
}

async function preserveAcceptedOutcome(
  db: PrismaClient,
  cas: {
    id: string;
    status: OnboardingMailDeliveryStatus;
    workerId: string;
    leaseGeneration: number;
    dispatchedAt: Date;
  },
  outcome: Extract<SmtpOutcome, { kind: "accepted" }>,
): Promise<void> {
  const responseSummary = protocolResponseSummary(outcome.responseSummary, outcome.protocolStage);
  try {
    const recovered = await db.onboardingMailDelivery.updateMany({
      where: cas,
      data: {
        status: OnboardingMailDeliveryStatus.UNKNOWN,
        workerId: null,
        leaseExpiresAt: null,
        retryable: false,
        nextRetryAt: null,
        failureCode: "ACCEPTED_STATE_UNPERSISTED",
        errorSummary: "SMTP accepted, but the final sent state could not be persisted",
        providerMessageId: outcome.providerMessageId,
        responseSummary,
      },
    });
    if (recovered.count === 1) return;
  } catch {
    // A second, narrower best-effort write below may still preserve evidence.
  }
  try {
    await db.onboardingMailDelivery.updateMany({
      where: {
        id: cas.id,
        status: OnboardingMailDeliveryStatus.UNKNOWN,
        unknownResolution: null,
        providerMessageId: null,
      },
      data: {
        providerMessageId: outcome.providerMessageId,
        responseSummary,
      },
    });
  } catch {
    // The caller must still surface ACCEPTED_STALE without risking a resend.
  }
}

export async function processDelivery(
  id: string,
  workerId: string,
  options: ProcessOptions,
): Promise<DeliveryResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const lookbackDays = validatedWelcomeMailLookbackDays(options.lookbackDays);
  const delivery = await db.onboardingMailDelivery.findFirst({
    where: { id, status: OnboardingMailDeliveryStatus.SENDING, workerId },
  });
  if (!delivery) return { id, status: "STALE" };

  const reason = await automaticEligibility(db, delivery, now, lookbackDays);
  if (reason) return cancelClaim(db, delivery, workerId, reason);
  const recipientReason = await currentRecipientEligibility(db, delivery);
  if (recipientReason) return cancelClaim(db, delivery, workerId, recipientReason);

  let message: SmtpMessage;
  try {
    const snapshot = parseSnapshot(delivery.templateSnapshot);
    const attachments = await loadVerifiedRevisionAttachments(
      db,
      delivery.templateRevisionId,
      options.privateRoot ?? defaultPrivateRoot,
      options.attachmentCache,
    );
    const cc = parseCc(delivery.ccSnapshot);
    message = {
      to: { email: delivery.recipientEmailSnapshot },
      senderDisplayName: snapshot.senderDisplayName,
      subject: snapshot.subject,
      html: snapshot.html,
      text: snapshot.text,
      cc,
      attachments,
    };
    assertMailMessageSize({
      from: snapshot.senderDisplayName,
      to: [delivery.recipientEmailSnapshot],
      cc: cc.map((item) => ({ email: item.email, displayName: item.displayName })),
      subject: snapshot.subject,
      html: snapshot.html,
      text: snapshot.text,
      attachments: attachments.filter((item) => !item.contentId),
      inlineResources: attachments.filter((item) => Boolean(item.contentId)),
    }, {
      rawAttachmentMaxBytes: options.rawAttachmentMaxBytes,
      encodedMimeMaxBytes: options.encodedMimeMaxBytes,
    });
  } catch (error) {
    const result = await db.onboardingMailDelivery.updateMany({
      where: { id, status: OnboardingMailDeliveryStatus.SENDING, workerId, leaseGeneration: delivery.leaseGeneration, dispatchedAt: null },
      data: {
        status: OnboardingMailDeliveryStatus.SKIPPED,
        workerId: null,
        leaseExpiresAt: null,
        retryable: false,
        failureCode: "LOCAL_VALIDATION_FAILED",
        errorSummary: sanitizeMailErrorSummary(error),
      },
    });
    return { id, status: result.count === 1 ? OnboardingMailDeliveryStatus.SKIPPED : "STALE" };
  }

  const lastReason = await automaticEligibility(db, delivery, now, lookbackDays);
  if (lastReason) return cancelClaim(db, delivery, workerId, lastReason);
  const lastRecipientReason = await currentRecipientEligibility(db, delivery);
  if (lastRecipientReason) return cancelClaim(db, delivery, workerId, lastRecipientReason);
  const dispatchedAt = now();
  const leaseDurationMs = options.leaseDurationMs ?? 180_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("邮件投递租约时长必须是正整数");
  }
  const marked = await db.onboardingMailDelivery.updateMany({
    where: {
      id,
      status: OnboardingMailDeliveryStatus.SENDING,
      workerId,
      leaseGeneration: delivery.leaseGeneration,
      dispatchedAt: null,
      ...(delivery.recipientId ? {
        recipient: {
          is: {
            id: delivery.recipientId,
            role: Role.EMPLOYEE,
            enabled: true,
            status: UserStatus.ACTIVE,
            email: delivery.recipientEmailSnapshot,
          },
        },
      } : {}),
    },
    data: { dispatchedAt, leaseExpiresAt: new Date(dispatchedAt.getTime() + leaseDurationMs) },
  });
  if (marked.count !== 1) {
    const dispatchRaceReason = await currentRecipientEligibility(db, delivery);
    if (dispatchRaceReason) return cancelClaim(db, delivery, workerId, dispatchRaceReason);
    return { id, status: "STALE" };
  }

  let outcome: SmtpOutcome;
  try {
    outcome = await options.transport.send(message);
  } catch (error) {
    outcome = {
      kind: "ambiguous",
      failureCode: "TRANSPORT_THROW",
      errorSummary: sanitizeMailErrorSummary(error),
      protocolStage: "DATA",
    };
  }
  const cas = {
    id,
    status: OnboardingMailDeliveryStatus.SENDING,
    workerId,
    leaseGeneration: delivery.leaseGeneration,
    dispatchedAt,
  } as const;
  if (outcome.kind === "accepted") {
    try {
      const updated = await db.onboardingMailDelivery.updateMany({ where: cas, data: {
        status: OnboardingMailDeliveryStatus.SENT,
        sentAt: now(),
        workerId: null,
        leaseExpiresAt: null,
        retryable: false,
        providerMessageId: outcome.providerMessageId,
        responseSummary: protocolResponseSummary(outcome.responseSummary, outcome.protocolStage),
      } });
      if (updated.count === 1) return { id, status: OnboardingMailDeliveryStatus.SENT, outcome };
    } catch {
      // Preserve the accepted outcome below before surfacing ACCEPTED_STALE.
    }
    await preserveAcceptedOutcome(db, cas, outcome);
    return { id, status: "ACCEPTED_STALE", outcome };
  }
  if (outcome.kind === "ambiguous") {
    const updated = await db.onboardingMailDelivery.updateMany({ where: cas, data: {
      status: OnboardingMailDeliveryStatus.UNKNOWN,
      workerId: null,
      leaseExpiresAt: null,
      retryable: false,
      nextRetryAt: null,
      failureCode: outcome.failureCode,
      errorSummary: outcome.errorSummary,
      responseSummary: protocolResponseSummary(null, outcome.protocolStage),
    } });
    return { id, status: updated.count === 1 ? OnboardingMailDeliveryStatus.UNKNOWN : "STALE", outcome };
  }
  const retryLimit = options.retryLimit ?? 3;
  const unattemptedTransportFailure = outcome.kind === "definite-retryable"
    && outcome.protocolStage === "PRE_DATA"
    && ["SMTP_TRANSPORT_POISONED", "SMTP_TRANSPORT_BUSY"].includes(outcome.failureCode);
  if (unattemptedTransportFailure) {
    const retryBaseMs = options.retryBaseMs ?? 60_000;
    const unattemptedFailureData = {
      status: OnboardingMailDeliveryStatus.FAILED,
      workerId: null,
      leaseExpiresAt: null,
      dispatchedAt: null,
      retryable: true,
      nextRetryAt: new Date(now().getTime() + retryBaseMs * 2 ** Math.max(0, delivery.attemptCount - 2)),
      failureCode: outcome.failureCode,
      errorSummary: outcome.errorSummary,
      responseSummary: protocolResponseSummary(null, outcome.protocolStage),
    } satisfies Prisma.OnboardingMailDeliveryUpdateManyMutationInput;
    const decremented = await db.onboardingMailDelivery.updateMany({
      where: { ...cas, attemptCount: { gt: 0 } },
      data: { ...unattemptedFailureData, attemptCount: { decrement: 1 } },
    });
    const updated = decremented.count === 1 ? decremented : await db.onboardingMailDelivery.updateMany({
      where: cas,
      data: { ...unattemptedFailureData, attemptCount: 0 },
    });
    return { id, status: updated.count === 1 ? OnboardingMailDeliveryStatus.FAILED : "STALE", outcome };
  }
  const retryable = outcome.kind === "definite-retryable" && delivery.attemptCount < retryLimit;
  const retryBaseMs = options.retryBaseMs ?? 60_000;
  const updated = await db.onboardingMailDelivery.updateMany({ where: cas, data: {
    status: OnboardingMailDeliveryStatus.FAILED,
    workerId: null,
    leaseExpiresAt: null,
    dispatchedAt: null,
    retryable,
    nextRetryAt: retryable ? new Date(now().getTime() + retryBaseMs * 2 ** Math.max(0, delivery.attemptCount - 1)) : null,
    failureCode: outcome.failureCode,
    errorSummary: outcome.errorSummary,
    responseSummary: protocolResponseSummary(null, outcome.protocolStage),
  } });
  return { id, status: updated.count === 1 ? OnboardingMailDeliveryStatus.FAILED : "STALE", outcome };
}

export async function resolveUnknownDelivery(
  id: string,
  input: { resolution: "CONFIRMED_DELIVERED" | "CONFIRMED_FAILED_RESEND"; resolverId: string | null; note: string },
  options: ClientOptions = {},
) {
  const db = options.db ?? prisma;
  const now = (options.now ?? (() => new Date()))();
  return withUnknownResolutionLock(id, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await db.$transaction(async (transaction) => {
          const delivery = await transaction.onboardingMailDelivery.findUniqueOrThrow({
            where: { id }, include: { resendDelivery: true },
          });
          const existing = resolvedUnknownResult(id, delivery, input.resolution);
          if (existing) return existing;
          if (delivery.status !== OnboardingMailDeliveryStatus.UNKNOWN) {
            throw new Error("只有 UNKNOWN 投递可以人工解决");
          }
          const resolver = input.resolverId
            ? await transaction.user.findUniqueOrThrow({ where: { id: input.resolverId } })
            : null;
          const claimed = await transaction.onboardingMailDelivery.updateMany({
            where: {
              id,
              status: OnboardingMailDeliveryStatus.UNKNOWN,
              unknownResolution: null,
            },
            data: {
              unknownResolution: input.resolution as OnboardingMailUnknownResolution,
              unknownResolvedAt: now,
              unknownResolvedById: resolver?.id ?? null,
              unknownResolverSnapshot: resolver ? snapshotUserIdentity(resolver) : undefined,
              unknownResolutionNote: input.note.trim().slice(0, 500),
            },
          });
          if (claimed.count !== 1) throw new UnknownResolutionCasLostError();
          let resendDeliveryId: string | null = null;
          if (input.resolution === "CONFIRMED_FAILED_RESEND") {
            const resend = await transaction.onboardingMailDelivery.create({ data: {
              status: OnboardingMailDeliveryStatus.PENDING,
              source: OnboardingMailDeliverySource.RESEND,
              idempotencyKey: null,
              recipientId: delivery.recipientId,
              recipientEmailSnapshot: delivery.recipientEmailSnapshot,
              recipientSnapshot: delivery.recipientSnapshot as Prisma.InputJsonValue,
              templateRevisionId: delivery.templateRevisionId,
              templateSnapshot: delivery.templateSnapshot as Prisma.InputJsonValue,
              fieldSummary: delivery.fieldSummary as Prisma.InputJsonValue,
              ccSnapshot: delivery.ccSnapshot as Prisma.InputJsonValue,
              attachmentSummary: delivery.attachmentSummary as Prisma.InputJsonValue,
              scheduledLocalDate: null,
              scheduledAt: now,
              actorId: resolver?.id ?? null,
              actorSnapshot: resolver ? snapshotUserIdentity(resolver) : undefined,
              resendOfId: delivery.id,
            } });
            resendDeliveryId = resend.id;
          }
          await writeAuditLog(transaction, {
            actorId: resolver?.id ?? null,
            action: `ONBOARDING_MAIL_UNKNOWN_${input.resolution}`,
            targetType: "ONBOARDING_MAIL_DELIVERY",
            targetId: id,
            result: "SUCCESS",
            metadata: resendDeliveryId ? { resendDeliveryId } : undefined,
          });
          return { deliveryId: id, resendDeliveryId, resolution: input.resolution };
        });
      } catch (error) {
        if (!isUnknownResolutionRace(error)) throw error;
        try {
          const reread = await db.onboardingMailDelivery.findUnique({
            where: { id }, include: { resendDelivery: true },
          });
          if (reread) {
            const existing = resolvedUnknownResult(id, reread, input.resolution);
            if (existing) return existing;
          }
        } catch (rereadError) {
          if (!isUnknownResolutionRace(rereadError)) throw rereadError;
        }
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
    throw new UnknownResolutionUnavailableError();
  });
}

type UnknownResolutionValue = "CONFIRMED_DELIVERED" | "CONFIRMED_FAILED_RESEND";

export class UnknownResolutionConflictError extends Error {
  readonly code = "UNKNOWN_RESOLUTION_CONFLICT";

  constructor(
    readonly existingResolution: OnboardingMailUnknownResolution,
    readonly requestedResolution: UnknownResolutionValue,
  ) {
    super("该 UNKNOWN 投递已以不同结果解决");
    this.name = "UnknownResolutionConflictError";
  }
}

class UnknownResolutionCasLostError extends Error {}

class UnknownResolutionUnavailableError extends Error {
  readonly code = "UNKNOWN_RESOLUTION_RETRY_EXHAUSTED";

  constructor() {
    super("UNKNOWN 投递解决暂时无法保存，请重试");
    this.name = "UnknownResolutionUnavailableError";
  }
}

function resolvedUnknownResult(
  deliveryId: string,
  delivery: { unknownResolution: OnboardingMailUnknownResolution | null; resendDelivery: { id: string } | null },
  requestedResolution: UnknownResolutionValue,
) {
  if (!delivery.unknownResolution) return null;
  if (delivery.unknownResolution !== requestedResolution) {
    throw new UnknownResolutionConflictError(delivery.unknownResolution, requestedResolution);
  }
  return {
    deliveryId,
    resendDeliveryId: delivery.resendDelivery?.id ?? null,
    resolution: delivery.unknownResolution,
  };
}

function isUnknownResolutionRace(error: unknown): boolean {
  if (error instanceof UnknownResolutionCasLostError) return true;
  if (!error || typeof error !== "object") return false;
  const item = error as Record<string, unknown>;
  const code = typeof item.code === "string" ? item.code : "";
  const message = typeof item.message === "string" ? item.message : "";
  return ["P1008", "P2002", "P2028", "P2034"].includes(code) || /database is locked|busy|unique constraint/i.test(message);
}

const unknownResolutionLocks = new Map<string, Promise<void>>();

async function withUnknownResolutionLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = unknownResolutionLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  unknownResolutionLocks.set(id, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (unknownResolutionLocks.get(id) === tail) unknownResolutionLocks.delete(id);
  }
}

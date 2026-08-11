import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { isAllowedInlineImageMime, verifyPersistedMailAsset } from "@/features/onboarding-mail/asset-service";
import { resolveMailFields, validateFieldConfig } from "@/features/onboarding-mail/field-registry";
import {
  renderTemplateContent,
  sanitizeTemplateHtml,
} from "@/features/onboarding-mail/template-renderer";
import {
  mailFieldConfigSchema,
  templateDraftSchema,
  type TemplateDraft,
} from "@/features/onboarding-mail/template-schemas";
import { prisma } from "@/lib/db/client";

type TemplateDb = PrismaClient;
type TemplateTransaction = Prisma.TransactionClient;
type TemplateReferenceDb = Pick<PrismaClient, "fileAsset" | "onboardingMaterialVersion" | "user"> | TemplateTransaction;
type TemplateOptions = { db?: TemplateDb; companyName?: string; now?: Date; privateRoot?: string; maxAssetBytes?: number };

export type TemplateRevision = Prisma.OnboardingMailTemplateRevisionGetPayload<{
  include: { attachments: true; ccEntries: true };
}>;

type RenderedMailCore = {
  recipient: { employeeId: string; email: string; name: string };
  senderDisplayName: string;
  subject: string;
  html: string;
  text: string;
  fields: Array<{ key: string; label: string; value: string }>;
};

export type RenderedMail = RenderedMailCore & {
  attachments: TemplateRevision["attachments"];
  ccEntries: TemplateRevision["ccEntries"];
};

export type WelcomeMailPreview = RenderedMailCore & {
  attachments: TemplateDraft["attachments"];
  ccEntries: TemplateDraft["ccEntries"];
};

export class TemplateServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ASSET_REFERENCE"
      | "INVALID_MATERIAL_VERSION"
      | "INVALID_CC_USER"
      | "DUPLICATE_CONTENT_ID"
      | "INVALID_BACKGROUND_REFERENCE"
      | "RECIPIENT_EMAIL_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "TemplateServiceError";
  }
}

async function authorizedActor(db: Pick<PrismaClient, "user"> | TemplateTransaction, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN) throw new AuthError("FORBIDDEN", 403);
  return { actor, snapshot: snapshotUserIdentity(actor) };
}

const CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,126}$/;

function backgroundContentId(styleConfig: Record<string, unknown>): string | null {
  const value = styleConfig.backgroundContentId;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CONTENT_ID.test(value)) {
    throw new TemplateServiceError("INVALID_BACKGROUND_REFERENCE", "邮件背景必须引用安全的 Content-ID");
  }
  return value;
}

function styledHtmlBody(htmlBody: string, styleConfig: Record<string, unknown>) {
  const contentId = backgroundContentId(styleConfig);
  if (!contentId) return htmlBody;
  return `<div style="background-image:url(cid:${contentId});background-repeat:no-repeat;background-size:cover">${htmlBody}</div>`;
}

function parsedDraft(input: TemplateDraft) {
  const draft = templateDraftSchema.parse(input);
  const fieldConfig = validateFieldConfig(draft.fieldConfig);
  const enabledKeys = fieldConfig.filter((field) => field.enabled).map((field) => field.key);
  const placeholderProbe = Object.fromEntries(enabledKeys.map((key) => [key, ""]));
  const allowedContentIds = draft.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId] : []);
  const backgroundId = backgroundContentId(draft.styleConfig);
  if (backgroundId && !draft.attachments.some((attachment) =>
    attachment.role === "INLINE_BACKGROUND" && attachment.contentId === backgroundId)) {
    throw new TemplateServiceError("INVALID_BACKGROUND_REFERENCE", "邮件背景必须引用本模板的背景素材");
  }
  renderTemplateContent({
    subject: draft.subject,
    htmlBody: styledHtmlBody(draft.htmlBody, draft.styleConfig),
    textBody: draft.textBody,
    allowedPlaceholders: enabledKeys,
    allowedContentIds,
    boundary: "DRAFT_SAVE",
    values: placeholderProbe,
  });
  const contentIds = draft.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId.toLowerCase()] : []);
  if (new Set(contentIds).size !== contentIds.length) {
    throw new TemplateServiceError("DUPLICATE_CONTENT_ID", "内嵌素材 Content-ID 不能重复");
  }
  return { ...draft, fieldConfig };
}

async function validateReferences(
  transaction: TemplateReferenceDb,
  draft: ReturnType<typeof parsedDraft>,
  options: { verifyPersistedAssets?: boolean; privateRoot?: string; maxAssetBytes?: number } = {},
) {
  const assetIds = draft.attachments.flatMap((attachment) => attachment.fileAssetId ? [attachment.fileAssetId] : []);
  if (assetIds.length) {
    const assets = await transaction.fileAsset.findMany({
      where: { id: { in: [...new Set(assetIds)] }, kind: FileAssetKind.ONBOARDING_EMAIL_ASSET },
      select: { id: true, mimeType: true, storageKey: true, originalName: true, sizeBytes: true, sha256: true },
    });
    if (assets.length !== new Set(assetIds).size) {
      throw new TemplateServiceError("INVALID_ASSET_REFERENCE", "邮件素材不存在或类型不正确");
    }
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const invalidInline = draft.attachments.some((attachment) =>
      attachment.role !== "ATTACHMENT"
      && (!attachment.fileAssetId || !isAllowedInlineImageMime(assetById.get(attachment.fileAssetId)?.mimeType ?? "")));
    if (invalidInline) {
      throw new TemplateServiceError("INVALID_ASSET_REFERENCE", "内嵌邮件素材必须是已验证的 PNG/JPEG/GIF/WebP");
    }
    if (options.verifyPersistedAssets) {
      for (const attachment of draft.attachments) {
        if (!attachment.fileAssetId) continue;
        await verifyPersistedMailAsset(assetById.get(attachment.fileAssetId)!, {
          role: attachment.role,
          contentId: attachment.contentId,
        }, {
          privateRoot: options.privateRoot,
          maxBytes: options.maxAssetBytes,
        });
      }
    }
  }
  const versionIds = draft.attachments.flatMap((attachment) => attachment.materialVersionId ? [attachment.materialVersionId] : []);
  if (versionIds.length) {
    const versions = await transaction.onboardingMaterialVersion.findMany({
      where: { id: { in: [...new Set(versionIds)] } },
      select: { id: true, material: { select: { status: true, currentVersionId: true } } },
    });
    if (versions.length !== new Set(versionIds).size || versions.some((version) =>
      version.material.status !== "PUBLISHED" || version.material.currentVersionId !== version.id)) {
      throw new TemplateServiceError("INVALID_MATERIAL_VERSION", "仅可引用已发布入职资料的当前版本");
    }
  }
  const ccUserIds = draft.ccEntries.flatMap((entry) => entry.kind === "USER" ? [entry.userId] : []);
  const ccUsers = ccUserIds.length ? await transaction.user.findMany({
    where: { id: { in: [...new Set(ccUserIds)] } },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  }) : [];
  if (ccUsers.length !== new Set(ccUserIds).size) {
    throw new TemplateServiceError("INVALID_CC_USER", "抄送账号不存在");
  }
  return new Map(ccUsers.map((entry) => [entry.id, entry]));
}

function attachmentRows(draft: ReturnType<typeof parsedDraft>) {
  return draft.attachments.map((attachment) => ({
    role: attachment.role,
    fileAssetId: attachment.fileAssetId ?? null,
    materialVersionId: attachment.materialVersionId ?? null,
    displayName: attachment.displayName,
    contentId: attachment.contentId ?? null,
    sortOrder: attachment.sortOrder,
  }));
}

function browserPreviewHtml(html: string, attachments: ReturnType<typeof parsedDraft>["attachments"]) {
  let previewHtml = html;
  for (const attachment of attachments) {
    if (!attachment.contentId || !attachment.fileAssetId) continue;
    const escaped = attachment.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const previewUrl = `/api/admin/onboarding-mail/assets/${encodeURIComponent(attachment.fileAssetId)}/preview`;
    previewHtml = previewHtml
      .replace(new RegExp(`src=(['"])cid:${escaped}\\1`, "g"), () => `src="${previewUrl}"`)
      .replace(new RegExp(`url\\(cid:${escaped}\\)`, "g"), `url(${previewUrl})`);
  }
  return previewHtml;
}

function ccRows(draft: ReturnType<typeof parsedDraft>) {
  return draft.ccEntries.map((entry) => ({
    kind: entry.kind,
    userId: entry.kind === "USER" ? entry.userId : null,
    email: entry.kind === "EMAIL" ? entry.email : null,
    displayName: entry.displayName ?? null,
    sortOrder: entry.sortOrder,
  }));
}

async function replaceStoredDraft(
  transaction: TemplateTransaction,
  actorId: string,
  actorSnapshot: Prisma.InputJsonValue,
  draft: ReturnType<typeof parsedDraft>,
) {
  const htmlBody = sanitizeTemplateHtml(draft.htmlBody, "DRAFT_SAVE", {
    allowedContentIds: draft.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId] : []),
  });
  await transaction.onboardingMailTemplate.update({
    where: { id: draft.templateId },
    data: {
      draftSenderName: draft.senderDisplayName,
      draftSubject: draft.subject,
      draftHtmlBody: htmlBody,
      draftTextBody: draft.textBody ?? "",
      draftFieldConfig: draft.fieldConfig as Prisma.InputJsonValue,
      draftStyleConfig: draft.styleConfig as Prisma.InputJsonValue,
      updatedById: actorId,
      updatedBySnapshot: actorSnapshot,
    },
  });
  await transaction.onboardingMailDraftAttachment.deleteMany({ where: { templateId: draft.templateId } });
  await transaction.onboardingMailDraftCc.deleteMany({ where: { templateId: draft.templateId } });
  if (draft.attachments.length) await transaction.onboardingMailDraftAttachment.createMany({
    data: attachmentRows(draft).map((row) => ({ ...row, templateId: draft.templateId })),
  });
  if (draft.ccEntries.length) await transaction.onboardingMailDraftCc.createMany({
    data: ccRows(draft).map((row) => ({ ...row, templateId: draft.templateId })),
  });
  return htmlBody;
}

export async function saveTemplateDraft(
  actorId: string,
  input: TemplateDraft,
  options: TemplateOptions = {},
) {
  return saveTemplateDraftWithSettings(actorId, input, undefined, options);
}

export async function saveTemplateDraftWithSettings(
  actorId: string,
  input: TemplateDraft,
  settings: { enabled: boolean; defaultSendTime: string } | undefined,
  options: TemplateOptions = {},
) {
  const db = options.db ?? prisma;
  await authorizedActor(db, actorId);
  const draft = parsedDraft(input);
  return db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    await validateReferences(transaction, draft);
    await replaceStoredDraft(transaction, actorId, snapshot, draft);
    if (settings) await transaction.onboardingMailTemplate.update({
      where: { id: draft.templateId },
      data: {
        enabled: settings.enabled,
        defaultSendTime: settings.defaultSendTime,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    await writeAuditLog(transaction, {
      actorId, action: "ONBOARDING_MAIL_DRAFT_SAVE", targetType: "ONBOARDING_MAIL_TEMPLATE", targetId: draft.templateId, result: "SUCCESS",
    });
    return transaction.onboardingMailTemplate.findUniqueOrThrow({
      where: { id: draft.templateId }, include: { draftAttachments: true, draftCcEntries: true },
    });
  });
}

const publicationQueues = new WeakMap<TemplateDb, Map<string, Promise<unknown>>>();

async function serializePublication<T>(db: TemplateDb, templateId: string, operation: () => Promise<T>): Promise<T> {
  const queues = publicationQueues.get(db) ?? new Map<string, Promise<unknown>>();
  publicationQueues.set(db, queues);
  const previous = queues.get(templateId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(templateId, current);
  try { return await current; }
  finally { if (queues.get(templateId) === current) queues.delete(templateId); }
}

function isRetryablePublicationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return ["P1008", "P2002", "P2034"].includes(code)
    || /database is locked|operation has timed out|unique constraint.*OnboardingMailTemplateRevision/i.test(message);
}

async function publishTemplateTransaction(
  db: TemplateDb,
  actorId: string,
  draft: ReturnType<typeof parsedDraft>,
  options: TemplateOptions,
  settings?: { enabled: boolean; defaultSendTime: string },
): Promise<TemplateRevision> {
  return db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const ccUsers = await validateReferences(transaction, draft, {
      verifyPersistedAssets: true,
      privateRoot: options.privateRoot,
      maxAssetBytes: options.maxAssetBytes,
    });
    await replaceStoredDraft(transaction, actorId, snapshot, draft);
    const latest = await transaction.onboardingMailTemplateRevision.findFirst({
      where: { templateId: draft.templateId }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true },
    });
    const revision = await transaction.onboardingMailTemplateRevision.create({
      data: {
        templateId: draft.templateId,
        revisionNumber: (latest?.revisionNumber ?? 0) + 1,
        senderDisplayName: draft.senderDisplayName,
        subject: draft.subject,
        htmlBody: sanitizeTemplateHtml(styledHtmlBody(draft.htmlBody, draft.styleConfig), "PUBLISH", {
          allowedContentIds: draft.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId] : []),
        }),
        textBody: draft.textBody ?? "",
        fieldConfig: draft.fieldConfig as Prisma.InputJsonValue,
        styleConfig: draft.styleConfig as Prisma.InputJsonValue,
        publishedById: actorId,
        publishedBySnapshot: snapshot,
        attachments: { create: attachmentRows(draft) },
        ccEntries: { create: draft.ccEntries.map((entry) => ({
          ...ccRows({ ...draft, ccEntries: [entry] })[0],
          userSnapshot: entry.kind === "USER"
            ? snapshotUserIdentity(ccUsers.get(entry.userId)!)
            : undefined,
        })) },
      },
      include: {
        attachments: { orderBy: { sortOrder: "asc" } },
        ccEntries: { orderBy: { sortOrder: "asc" } },
      },
    });
    await transaction.onboardingMailTemplate.update({
      where: { id: draft.templateId },
      data: {
        currentRevisionId: revision.id,
        ...(settings ? {
          enabled: settings.enabled,
          defaultSendTime: settings.defaultSendTime,
          updatedById: actorId,
          updatedBySnapshot: snapshot,
        } : {}),
      },
    });
    await writeAuditLog(transaction, {
      actorId, action: "ONBOARDING_MAIL_TEMPLATE_PUBLISH", targetType: "ONBOARDING_MAIL_TEMPLATE_REVISION", targetId: revision.id,
      result: "SUCCESS", metadata: { revisionNumber: revision.revisionNumber },
    });
    return revision;
  });
}

export async function publishTemplate(
  actorId: string,
  input: TemplateDraft,
  options: TemplateOptions = {},
  settings?: { enabled: boolean; defaultSendTime: string },
): Promise<TemplateRevision> {
  const db = options.db ?? prisma;
  await authorizedActor(db, actorId);
  const draft = parsedDraft(input);
  return serializePublication(db, draft.templateId, async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await publishTemplateTransaction(db, actorId, draft, options, settings);
      } catch (error) {
        if (!isRetryablePublicationError(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new Error("邮件模板发布重试失败");
  });
}

export async function renderWelcomeTemplate(
  revisionId: string,
  employeeId: string,
  options: TemplateOptions = {},
): Promise<RenderedMail> {
  const db = options.db ?? prisma;
  const [revision, employee] = await Promise.all([
    db.onboardingMailTemplateRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: {
        attachments: { orderBy: { sortOrder: "asc" } },
        ccEntries: { orderBy: { sortOrder: "asc" } },
      },
    }),
    db.user.findUniqueOrThrow({ where: { id: employeeId } }),
  ]);
  if (!employee.email) throw new TemplateServiceError("RECIPIENT_EMAIL_MISSING", "收件人账号没有邮箱");
  const fieldConfig = validateFieldConfig(mailFieldConfigSchema.array().parse(revision.fieldConfig));
  const fields = resolveMailFields(fieldConfig, employee, {
    companyName: options.companyName ?? "",
    now: options.now,
  });
  const rendered = renderTemplateContent({
    subject: revision.subject,
    htmlBody: revision.htmlBody,
    textBody: revision.textBody,
    allowedPlaceholders: fieldConfig.filter((field) => field.enabled).map((field) => field.key),
    allowedContentIds: revision.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId] : []),
    boundary: "SEND",
    values: fields.values,
  });
  return {
    recipient: { employeeId: employee.id, email: employee.email, name: employee.name },
    senderDisplayName: revision.senderDisplayName,
    ...rendered,
    fields: fields.ordered,
    attachments: revision.attachments,
    ccEntries: revision.ccEntries,
  };
}

export async function previewWelcomeTemplate(
  actorId: string,
  input: TemplateDraft,
  employeeId: string,
  options: TemplateOptions = {},
): Promise<WelcomeMailPreview> {
  const db = options.db ?? prisma;
  await authorizedActor(db, actorId);
  const draft = parsedDraft(input);
  await validateReferences(db, draft, {
    verifyPersistedAssets: true,
    privateRoot: options.privateRoot,
    maxAssetBytes: options.maxAssetBytes,
  });
  const employee = await db.user.findUniqueOrThrow({ where: { id: employeeId } });
  if (!employee.email) throw new TemplateServiceError("RECIPIENT_EMAIL_MISSING", "收件人账号没有邮箱");
  const fields = resolveMailFields(draft.fieldConfig, employee, {
    companyName: options.companyName ?? "",
    now: options.now,
  });
  const rendered = renderTemplateContent({
    subject: draft.subject,
    htmlBody: styledHtmlBody(draft.htmlBody, draft.styleConfig),
    textBody: draft.textBody,
    allowedPlaceholders: draft.fieldConfig.filter((field) => field.enabled).map((field) => field.key),
    allowedContentIds: draft.attachments.flatMap((attachment) => attachment.contentId ? [attachment.contentId] : []),
    boundary: "PREVIEW",
    values: fields.values,
  });
  return {
    recipient: { employeeId: employee.id, email: employee.email, name: employee.name },
    senderDisplayName: draft.senderDisplayName,
    ...rendered,
    html: browserPreviewHtml(rendered.html, draft.attachments),
    fields: fields.ordered,
    attachments: draft.attachments,
    ccEntries: draft.ccEntries,
  };
}

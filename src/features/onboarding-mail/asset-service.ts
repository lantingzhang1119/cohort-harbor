import "server-only";

import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailAttachmentRole } from "@/generated/prisma/enums";
import { FileAssetKind, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { validateOnboardingUpload } from "@/features/onboarding-kit/file-validation";
import type { UploadFileLike, UploadLimits, ValidatedUpload } from "@/features/onboarding-kit/file-types";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";
import { prepareMailValidationTempRoot, storeStagedPrivateUpload } from "@/lib/storage/private-upload-validation";

export const DEFAULT_MAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const INLINE_ROLES = new Set<OnboardingMailAttachmentRole>([
  OnboardingMailAttachmentRole.INLINE_LOGO,
  OnboardingMailAttachmentRole.INLINE_BACKGROUND,
  OnboardingMailAttachmentRole.INLINE_BODY,
]);
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const CONTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,126}$/;

export class MailAssetError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INLINE_TYPE"
      | "INVALID_CONTENT_ID"
      | "UNEXPECTED_CONTENT_ID"
      | "ASSET_CLEANUP_FAILED"
      | "ASSET_INTEGRITY_MISMATCH"
      | "ASSET_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "MailAssetError";
  }
}

async function authorizedActor(db: Pick<PrismaClient, "user"> | Prisma.TransactionClient, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN) throw new AuthError("FORBIDDEN", 403);
  return { actor, snapshot: snapshotUserIdentity(actor) };
}

export function isAllowedInlineImageMime(mimeType: string): boolean {
  return INLINE_IMAGE_MIMES.has(mimeType);
}

export async function validateMailAsset(
  file: UploadFileLike,
  input: { role: OnboardingMailAttachmentRole; contentId?: string },
  limits: Partial<UploadLimits> = {},
): Promise<{ validated: ValidatedUpload; contentId: string | null }> {
  const inline = INLINE_ROLES.has(input.role);
  if (inline && !isAllowedInlineImageMime(file.mimeType)) {
    throw new MailAssetError("INVALID_INLINE_TYPE", "内嵌素材仅支持 PNG/JPEG/GIF/WebP");
  }
  if (inline && (!input.contentId || !CONTENT_ID.test(input.contentId))) {
    throw new MailAssetError("INVALID_CONTENT_ID", "内嵌素材需要安全且唯一的 Content-ID");
  }
  if (!inline && input.contentId) {
    throw new MailAssetError("UNEXPECTED_CONTENT_ID", "普通附件不能设置 Content-ID");
  }
  const validated = await validateOnboardingUpload(file, {
    ...limits,
    maxBytes: limits.maxBytes ?? DEFAULT_MAIL_ATTACHMENT_MAX_BYTES,
  });
  if (inline && !isAllowedInlineImageMime(validated.mimeType)) {
    await validated.cleanup();
    throw new MailAssetError("INVALID_INLINE_TYPE", "内嵌素材仅支持 PNG/JPEG/GIF/WebP");
  }
  return { validated, contentId: input.contentId ?? null };
}

type UploadMailAssetOptions = {
  db?: PrismaClient;
  privateRoot?: string;
  maxBytes?: number;
  hooks?: { afterAssetCreate?: (assetId: string) => void | Promise<void> };
};

export type UploadMailAssetResult = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  warnings: Array<"STAGING_CLEANUP_FAILED">;
};

export async function uploadMailAsset(
  actorId: string,
  file: UploadFileLike,
  input: { role: OnboardingMailAttachmentRole; contentId?: string },
  options: UploadMailAssetOptions = {},
): Promise<UploadMailAssetResult> {
  const db = options.db ?? prisma;
  const privateRoot = options.privateRoot ?? defaultPrivateRoot;
  const tempRoot = await prepareMailValidationTempRoot(privateRoot);
  await authorizedActor(db, actorId);
  const { validated } = await validateMailAsset(file, input, {
    maxBytes: options.maxBytes ?? DEFAULT_MAIL_ATTACHMENT_MAX_BYTES,
    tempRoot,
  });
  let stored: Awaited<ReturnType<typeof storeStagedPrivateUpload>> | undefined;
  let result: UploadMailAssetResult | undefined;
  try {
    stored = await storeStagedPrivateUpload(validated.stagedPath, {
      privateRoot,
      namespace: "onboarding/mail-assets",
      extension: validated.extension,
    });
    try {
      const created = await db.$transaction(async (transaction) => {
        const { snapshot } = await authorizedActor(transaction, actorId);
        const asset = await transaction.fileAsset.create({ data: {
          kind: FileAssetKind.ONBOARDING_EMAIL_ASSET,
          storageKey: stored!.storageKey,
          originalName: validated.originalName,
          mimeType: validated.mimeType,
          sizeBytes: validated.sizeBytes,
          sha256: validated.sha256,
          uploadedById: actorId,
          uploadedBySnapshot: snapshot,
        } });
        await options.hooks?.afterAssetCreate?.(asset.id);
        await writeAuditLog(transaction, {
          actorId,
          action: "ONBOARDING_MAIL_ASSET_UPLOAD",
          targetType: "FILE_ASSET",
          targetId: asset.id,
          result: "SUCCESS",
          metadata: { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes },
        });
        return asset;
      });
      result = {
        id: created.id,
        originalName: created.originalName,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        sha256: created.sha256,
        createdAt: created.createdAt,
        warnings: [],
      };
    } catch (error) {
      try { await stored.cleanup(); }
      catch { throw new MailAssetError("ASSET_CLEANUP_FAILED", "邮件素材写入失败且私有文件清理失败"); }
      throw error;
    }
  } finally {
    try {
      await validated.cleanup();
    } catch {
      if (result) result.warnings.push("STAGING_CLEANUP_FAILED");
      else throw new MailAssetError("ASSET_CLEANUP_FAILED", "邮件素材暂存文件清理失败");
    }
  }
  return result!;
}

export async function verifyPersistedMailAsset(
  asset: {
    storageKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  },
  input: { role: OnboardingMailAttachmentRole; contentId?: string | null },
  options: { privateRoot?: string; maxBytes?: number; tempRoot?: string } = {},
): Promise<Buffer> {
  const privateRoot = options.privateRoot ?? defaultPrivateRoot;
  const tempRoot = await prepareMailValidationTempRoot(privateRoot, options.tempRoot);
  const maxBytes = options.maxBytes ?? DEFAULT_MAIL_ATTACHMENT_MAX_BYTES;
  const absolutePath = await resolvePrivateAssetPathSecure(asset.storageKey, privateRoot);
  if (!absolutePath) throw new MailAssetError("ASSET_INTEGRITY_MISMATCH", "邮件素材私有文件不存在或路径无效");
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new MailAssetError("ASSET_INTEGRITY_MISMATCH", "邮件素材私有文件无法安全打开");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new MailAssetError("ASSET_INTEGRITY_MISMATCH", "邮件素材不是有效的普通文件");
    }
    if (stats.size > maxBytes) {
      throw new MailAssetError("ASSET_TOO_LARGE", "邮件素材持久化文件超过复核大小限制");
    }
    if (stats.size !== asset.sizeBytes) {
      throw new MailAssetError("ASSET_INTEGRITY_MISMATCH", "邮件素材持久化大小与冻结元数据不一致");
    }
    const verified = await validateMailAsset({
      fileName: asset.originalName,
      mimeType: asset.mimeType,
      size: stats.size,
      stream: () => handle.readableWebStream({ autoClose: false }) as ReadableStream<Uint8Array>,
    }, {
      role: input.role,
      contentId: input.contentId ?? undefined,
    }, { maxBytes, tempRoot });
    try {
      if (verified.validated.sizeBytes !== stats.size || verified.validated.sha256 !== asset.sha256) {
        throw new MailAssetError("ASSET_INTEGRITY_MISMATCH", "邮件素材持久化字节与冻结元数据不一致");
      }
      return await readFile(verified.validated.stagedPath);
    } finally {
      await verified.validated.cleanup();
    }
  } finally {
    await handle.close();
  }
}

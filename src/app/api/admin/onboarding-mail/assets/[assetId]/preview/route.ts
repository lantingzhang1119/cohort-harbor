import path from "node:path";

import { NextResponse } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind, OnboardingMailAttachmentRole } from "@/generated/prisma/enums";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { isAllowedInlineImageMime, verifyPersistedMailAsset } from "@/features/onboarding-mail/asset-service";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";
import { resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";
import { mailAttachmentMaxBytes } from "../../route";

type Dependencies = { db: PrismaClient; privateRoot: string; maxBytes: number };

function notFound() {
  return NextResponse.json({ ok: false, code: "NOT_FOUND", message: "邮件预览素材不存在" }, { status: 404 });
}

export function createOnboardingMailAssetPreviewRoute(dependencies: Dependencies, assetId: string) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(dependencies.db, request);
      } catch (error) {
        return onboardingMailErrorResponse(error);
      }

      try {
        const asset = await dependencies.db.fileAsset.findFirst({
          where: { id: assetId, kind: FileAssetKind.ONBOARDING_EMAIL_ASSET },
          select: {
            id: true,
            storageKey: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            sha256: true,
          },
        });
        if (!asset || !isAllowedInlineImageMime(asset.mimeType)) return notFound();

        await verifyPersistedMailAsset(asset, {
          role: OnboardingMailAttachmentRole.INLINE_BODY,
          contentId: "preview",
        }, {
          privateRoot: dependencies.privateRoot,
          maxBytes: dependencies.maxBytes,
        });
        const filePath = await resolvePrivateAssetPathSecure(asset.storageKey, dependencies.privateRoot);
        if (!filePath) return notFound();

        return await createPrivateFileResponse(filePath, {
          contentType: asset.mimeType,
          size: asset.sizeBytes,
          headers: {
            "cache-control": "private, no-store, max-age=0",
            "content-disposition": `inline; filename="mail-preview-${asset.id}"`,
          },
        });
      } catch {
        return notFound();
      }
    },
  };
}

function productionRoute(assetId: string) {
  const env = getEnv();
  return createOnboardingMailAssetPreviewRoute({
    db: prisma,
    privateRoot: path.resolve(/* turbopackIgnore: true */ env.PRIVATE_STORAGE_ROOT),
    maxBytes: mailAttachmentMaxBytes(env.ONBOARDING_MAIL_ATTACHMENT_MAX_MB),
  }, assetId);
}

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  return productionRoute((await context.params).assetId).GET(request);
}

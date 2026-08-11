import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind, OnboardingMailAttachmentRole, OnboardingMaterialStatus } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { uploadMailAsset } from "@/features/onboarding-mail/asset-service";
import { toUploadFile } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

const roleSchema = z.enum([
  OnboardingMailAttachmentRole.ATTACHMENT,
  OnboardingMailAttachmentRole.INLINE_LOGO,
  OnboardingMailAttachmentRole.INLINE_BACKGROUND,
  OnboardingMailAttachmentRole.INLINE_BODY,
]);
type Deps = { db: PrismaClient; privateRoot: string; maxBytes: number };
export function mailAttachmentMaxBytes(megabytes: number) {
  const bytes = megabytes * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("邮件附件大小配置无效");
  return bytes;
}
export function createOnboardingMailAssetsRoute(deps: Deps) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(deps.db, request);
        const [assets, materials] = await Promise.all([
          deps.db.fileAsset.findMany({ where: { kind: FileAssetKind.ONBOARDING_EMAIL_ASSET }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
          deps.db.onboardingMaterial.findMany({ where: { status: OnboardingMaterialStatus.PUBLISHED, currentVersionId: { not: null } }, select: { id: true, title: true, currentVersion: { select: { id: true, displayName: true, mimeType: true, sizeBytes: true } } }, orderBy: { title: "asc" } }),
        ]);
        return NextResponse.json({ ok: true, assets, materials });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return NextResponse.json({ ok: false, code: "VALIDATION_ERROR", message: "请选择素材文件" }, { status: 400 });
        const role = roleSchema.parse(form.get("role"));
        const contentId = String(form.get("contentId") ?? "").trim() || undefined;
        const asset = await uploadMailAsset(actor.id, toUploadFile(file), { role, contentId }, { db: deps.db, privateRoot: deps.privateRoot, maxBytes: deps.maxBytes });
        return NextResponse.json({ ok: true, asset: { ...asset, role, contentId: contentId ?? null } }, { status: 201 });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
  };
}
function productionRoute() {
  const env = getEnv();
  return createOnboardingMailAssetsRoute({
    db: prisma,
    privateRoot: path.resolve(/* turbopackIgnore: true */ env.PRIVATE_STORAGE_ROOT),
    maxBytes: mailAttachmentMaxBytes(env.ONBOARDING_MAIL_ATTACHMENT_MAX_MB),
  });
}
export async function GET(request: Request) { return productionRoute().GET(request); }
export async function POST(request: Request) { return productionRoute().POST(request); }

import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { writeAuditLog } from "@/features/audit/audit-service";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { createAttachmentDisposition } from "@/features/onboarding-kit/download-name";
import { replaceMaterialFile } from "@/features/onboarding-kit/material-service";
import { MAX_ONBOARDING_FILE_BYTES, onboardingErrorResponse, onboardingNotFound, toUploadFile } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string; maxBytes: number };

export function createAdminMaterialFileRoute(dependencies: Dependencies, materialId: string) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireAdminRequest(dependencies.db, request);
        const versionId = new URL(request.url).searchParams.get("versionId");
        const material = await dependencies.db.onboardingMaterial.findUnique({
          where: { id: materialId }, select: { currentVersionId: true },
        });
        if (!material) return onboardingNotFound();
        const selectedVersionId = versionId ?? material.currentVersionId;
        if (!selectedVersionId) return onboardingNotFound();
        const version = await dependencies.db.onboardingMaterialVersion.findFirst({
          where: { id: selectedVersionId, materialId }, include: { fileAsset: true },
        });
        if (!version) return onboardingNotFound();
        const filePath = await resolvePrivateAssetPathSecure(version.fileAsset.storageKey, dependencies.privateRoot);
        if (!filePath) return onboardingNotFound();
        await writeAuditLog(dependencies.db, {
          actorId: actor.id,
          action: "ONBOARDING_MATERIAL_ADMIN_DOWNLOAD",
          targetType: "ONBOARDING_MATERIAL",
          targetId: materialId,
          result: "SUCCESS",
          metadata: { versionId: version.id, versionNumber: version.versionNumber, historical: version.id !== material.currentVersionId },
        });
        return createPrivateFileResponse(filePath, {
          contentType: version.mimeType,
          size: version.sizeBytes,
          headers: { "content-disposition": createAttachmentDisposition(version.displayName || version.originalName, `material-v${version.versionNumber}${version.extension}`) },
        });
      } catch (error) { return onboardingErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(dependencies.db, request);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "请选择新版本文件" }, { status: 400 });
        const material = await replaceMaterialFile(actor.id, materialId, toUploadFile(file), dependencies);
        return NextResponse.json({ ok: true, material });
      } catch (error) { return onboardingErrorResponse(error); }
    },
  };
}

const deps = { db: prisma, privateRoot: defaultPrivateRoot, maxBytes: MAX_ONBOARDING_FILE_BYTES };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createAdminMaterialFileRoute(deps, (await context.params).id).GET(request); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createAdminMaterialFileRoute(deps, (await context.params).id).POST(request); }

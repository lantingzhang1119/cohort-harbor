import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey, OnboardingMaterialStatus } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { createAttachmentDisposition } from "@/features/onboarding-kit/download-name";
import { onboardingErrorResponse, onboardingNotFound } from "@/features/onboarding-kit/route-utils";
import { OnboardingZipError, publishedMaterialSnapshotsAreCurrent } from "@/features/onboarding-kit/zip-service";
import { prisma } from "@/lib/db/client";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

export function createOnboardingMaterialDownloadRoute({ db, privateRoot }: { db: PrismaClient; privateRoot: string }, materialId: string) {
  return async function GET(request: Request) {
    let response: Response | undefined;
    try {
      const actor = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.ONBOARDING_KIT);
      const material = await db.onboardingMaterial.findFirst({
        where: {
          id: materialId,
          status: OnboardingMaterialStatus.PUBLISHED,
          deletedAt: null,
          currentVersionId: { not: null },
        },
        include: { currentVersion: { include: { fileAsset: true } } },
      });
      const version = material?.currentVersion;
      if (!material || !version || version.deletedAt || material.currentVersionId !== version.id) return onboardingNotFound();
      const filePath = await resolvePrivateAssetPathSecure(version.fileAsset.storageKey, privateRoot);
      if (!filePath) return onboardingNotFound();
      response = await createPrivateFileResponse(filePath, {
        contentType: version.mimeType,
        size: version.sizeBytes,
        headers: { "content-disposition": createAttachmentDisposition(version.displayName || version.originalName, `material${version.extension}`) },
      });
      const selection = [{ materialId: material.id, currentVersionId: version.id }];
      if (!await publishedMaterialSnapshotsAreCurrent(db, selection)) {
        throw new OnboardingZipError("SELECTION_CHANGED", "资料已下架或发生变化，请刷新后重试");
      }
      await writeAuditLog(db, {
        actorId: actor.user.id, action: "ONBOARDING_MATERIAL_DOWNLOAD", targetType: "ONBOARDING_MATERIAL",
        targetId: material.id, result: "SUCCESS", metadata: { versionId: version.id, versionNumber: version.versionNumber },
      });
      if (!await publishedMaterialSnapshotsAreCurrent(db, selection)) {
        throw new OnboardingZipError("SELECTION_CHANGED", "资料已下架或发生变化，请刷新后重试");
      }
      const handoff = response;
      response = undefined;
      return handoff;
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined);
      return onboardingErrorResponse(error);
    }
  };
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createOnboardingMaterialDownloadRoute({ db: prisma, privateRoot: defaultPrivateRoot }, (await context.params).id)(request); }

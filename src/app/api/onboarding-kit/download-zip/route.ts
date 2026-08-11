import path from "node:path";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { createAttachmentDisposition } from "@/features/onboarding-kit/download-name";
import { onboardingErrorResponse } from "@/features/onboarding-kit/route-utils";
import { buildOnboardingZip, OnboardingZipError, publishedMaterialSnapshotsAreCurrent, type PreparedPrivateArchive } from "@/features/onboarding-kit/zip-service";
import { prisma } from "@/lib/db/client";
import { getEnv, type AppEnv } from "@/lib/env";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";

const YYYYMMDD = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("-", "");
type Dependencies = { db: PrismaClient; privateRoot: string; zipRoot: string; maxItems: number; maxTotalBytes: number; maxConcurrentBuilds?: number };

type ZipRuntimeEnv = Pick<AppEnv,
  "ONBOARDING_ZIP_TEMP_ROOT" | "ONBOARDING_ZIP_MAX_FILES" | "ONBOARDING_ZIP_MAX_MB" | "ONBOARDING_ZIP_MAX_CONCURRENT"
>;

function onboardingZipMaxBytes(megabytes: number) {
  const bytes = megabytes * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("资料包大小配置无效");
  return bytes;
}

export function onboardingZipRuntimeOptions(env: ZipRuntimeEnv) {
  return {
    zipRoot: path.resolve(/* turbopackIgnore: true */ env.ONBOARDING_ZIP_TEMP_ROOT),
    maxItems: env.ONBOARDING_ZIP_MAX_FILES,
    maxTotalBytes: onboardingZipMaxBytes(env.ONBOARDING_ZIP_MAX_MB),
    maxConcurrentBuilds: env.ONBOARDING_ZIP_MAX_CONCURRENT,
  };
}

export function createOnboardingKitZipRoute(dependencies: Dependencies) {
  return async function POST(request: Request) {
    let prepared: PreparedPrivateArchive | undefined;
    let response: Response | undefined;
    try {
      assertSameOrigin(request);
      const actor = await requireEmployeeModuleRequest(dependencies.db, request, EmployeeModuleKey.ONBOARDING_KIT);
      const body = await request.json() as { materialIds?: unknown };
      const materialIds = Array.isArray(body.materialIds) ? body.materialIds.filter((id): id is string => typeof id === "string") : [];
      prepared = await buildOnboardingZip({ ...dependencies, materialIds });
      if (!await publishedMaterialSnapshotsAreCurrent(dependencies.db, prepared.selections)) {
        throw new OnboardingZipError("SELECTION_CHANGED", "部分资料已下架或发生变化，请刷新后重试");
      }
      const name = `CohortHarbor入职资料包_${YYYYMMDD(new Date())}.zip`;
      response = await createPrivateFileResponse(prepared.path, {
        contentType: "application/zip", size: prepared.sizeBytes, onClose: prepared.cleanup,
        headers: { "content-disposition": createAttachmentDisposition(name, `cohort-harbor-onboarding-kit-${YYYYMMDD(new Date())}.zip`) },
      });
      await writeAuditLog(dependencies.db, {
        actorId: actor.user.id, action: "ONBOARDING_MATERIAL_ZIP_DOWNLOAD", targetType: "ONBOARDING_MATERIAL",
        result: "SUCCESS", metadata: { materialIds, itemCount: materialIds.length },
      });
      if (!await publishedMaterialSnapshotsAreCurrent(dependencies.db, prepared.selections)) {
        throw new OnboardingZipError("SELECTION_CHANGED", "部分资料已下架或发生变化，请刷新后重试");
      }
      const handoff = response;
      response = undefined;
      prepared = undefined;
      return handoff;
    } catch (error) {
      if (response) await response.body?.cancel().catch(() => undefined);
      else await prepared?.cleanup().catch(() => undefined);
      return onboardingErrorResponse(error);
    }
  };
}

function productionRoute() {
  const env = getEnv();
  return createOnboardingKitZipRoute({
    db: prisma,
    privateRoot: path.resolve(/* turbopackIgnore: true */ env.PRIVATE_STORAGE_ROOT),
    ...onboardingZipRuntimeOptions(env),
  });
}

export async function POST(request: Request) {
  return productionRoute()(request);
}

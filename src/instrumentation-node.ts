import path from "node:path";

import { purgeExpiredContentRecycleBin } from "@/features/content-recycle/purge-expired";
import { initializeOnboardingZipCleanup } from "@/features/onboarding-kit/zip-service";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db/client";
import { cleanupStalePrivateUploads, resolveMailValidationTempRoot } from "@/lib/storage/private-upload-validation";

export async function registerNodeInstrumentation() {
  const env = getEnv();
  await initializeOnboardingZipCleanup({
    zipRoot: path.resolve(/* turbopackIgnore: true */ env.ONBOARDING_ZIP_TEMP_ROOT),
  });
  const privateRoot = path.resolve(/* turbopackIgnore: true */ env.PRIVATE_STORAGE_ROOT);
  const tempRoot = resolveMailValidationTempRoot(privateRoot);
  await cleanupStalePrivateUploads({ privateRoot, tempRoot });
  // Idempotent 30-day recycle-bin purge for policies and onboarding materials.
  await purgeExpiredContentRecycleBin({ db: prisma, privateRoot }).catch(() => undefined);
}

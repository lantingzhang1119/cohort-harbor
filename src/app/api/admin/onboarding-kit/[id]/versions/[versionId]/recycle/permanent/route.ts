import { createAdminMaterialVersionPermanentDeleteRoute } from "@/app/api/admin/onboarding-kit/[id]/versions/[versionId]/recycle/route";
import { MAX_ONBOARDING_FILE_BYTES } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  return createAdminMaterialVersionPermanentDeleteRoute({
    db: prisma,
    privateRoot: defaultPrivateRoot,
    maxBytes: MAX_ONBOARDING_FILE_BYTES,
  }, id, versionId)(request);
}

import { createAdminMaterialRestoreRoute } from "@/app/api/admin/onboarding-kit/[id]/recycle/route";
import { MAX_ONBOARDING_FILE_BYTES } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminMaterialRestoreRoute({
    db: prisma,
    privateRoot: defaultPrivateRoot,
    maxBytes: MAX_ONBOARDING_FILE_BYTES,
  }, id)(request);
}

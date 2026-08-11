import { createAdminPolicyVersionPermanentDeleteRoute } from "@/app/api/admin/policies/[id]/versions/[versionId]/recycle/route";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  return createAdminPolicyVersionPermanentDeleteRoute(
    { db: prisma, privateRoot: defaultPrivateRoot },
    id,
    versionId,
  )(request);
}

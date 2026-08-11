import { createAdminPolicyPermanentDeleteRoute } from "@/app/api/admin/policies/[id]/recycle/route";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminPolicyPermanentDeleteRoute({ db: prisma, privateRoot: defaultPrivateRoot }, id)(request);
}

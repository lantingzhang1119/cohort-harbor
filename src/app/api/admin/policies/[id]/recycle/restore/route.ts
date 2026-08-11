import type { PrismaClient } from "@/generated/prisma/client";
import { createAdminPolicyRestoreRoute } from "@/app/api/admin/policies/[id]/recycle/route";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export function createRoute(dependencies: { db: PrismaClient; privateRoot: string }, policyId: string) {
  return createAdminPolicyRestoreRoute(dependencies, policyId);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminPolicyRestoreRoute({ db: prisma, privateRoot: defaultPrivateRoot }, id)(request);
}

import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { getAdminAccount } from "@/features/admin-accounts/admin-account-service";
import {
  adminAccountErrorResponse,
  requireSuperAdminRequest,
} from "@/features/admin-accounts/route-utils";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdministratorDetailRoute(
  { db }: { db: PrismaClient },
  administratorId: string,
) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireSuperAdminRequest(db, request);
        const admin = await getAdminAccount(db, administratorId, actor.id);
        return NextResponse.json({ ok: true, admin });
      } catch (error) {
        return adminAccountErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createAdministratorDetailRoute({ db: prisma }, id).GET(request);
}

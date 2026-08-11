import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { transferAdminAccount } from "@/features/admin-accounts/admin-account-service";
import {
  adminAccountErrorResponse,
  requireSuperAdminRequest,
} from "@/features/admin-accounts/route-utils";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdministratorTransferRoute(
  { db }: { db: PrismaClient },
  administratorId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireSuperAdminRequest(db, request);
      const admin = await transferAdminAccount(
        db,
        administratorId,
        (await request.json()) as Parameters<typeof transferAdminAccount>[2],
        actor.id,
      );
      return NextResponse.json({ ok: true, admin });
    } catch (error) {
      return adminAccountErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createAdministratorTransferRoute({ db: prisma }, id)(request);
}

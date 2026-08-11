import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { permanentlyDeleteAdminAccount } from "@/features/admin-accounts/admin-account-service";
import {
  adminAccountErrorResponse,
  requireSuperAdminRequest,
} from "@/features/admin-accounts/route-utils";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdministratorPermanentDeleteRoute(
  { db }: { db: PrismaClient },
  administratorId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireSuperAdminRequest(db, request);
      await permanentlyDeleteAdminAccount(
        db,
        administratorId,
        (await request.json()) as Parameters<typeof permanentlyDeleteAdminAccount>[2],
        actor.id,
      );
      return NextResponse.json({ ok: true });
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
  return createAdministratorPermanentDeleteRoute({ db: prisma }, id)(request);
}

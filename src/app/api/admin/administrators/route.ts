import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  createAdminAccount,
  listAdminAccounts,
} from "@/features/admin-accounts/admin-account-service";
import {
  adminAccountErrorResponse,
  requireSuperAdminRequest,
} from "@/features/admin-accounts/route-utils";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdministratorsRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireSuperAdminRequest(db, request);
        const result = await listAdminAccounts(db, actor.id);
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return adminAccountErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireSuperAdminRequest(db, request);
        const result = await createAdminAccount(
          db,
          (await request.json()) as Parameters<typeof createAdminAccount>[1],
          actor.id,
        );
        return NextResponse.json({ ok: true, ...result }, { status: 201 });
      } catch (error) {
        return adminAccountErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const handlers = createAdministratorsRoute({ db: prisma });
export const GET = handlers.GET;
export const POST = handlers.POST;

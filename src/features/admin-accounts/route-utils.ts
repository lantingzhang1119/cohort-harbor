import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { AdminAccountServiceError } from "@/features/admin-accounts/admin-account-service";
import { requireSession, requireSuperAdmin } from "@/features/auth/guards";
import { readSessionToken } from "@/features/auth/route-utils";

export async function requireSuperAdminRequest(db: PrismaClient, request: Request) {
  const session = await requireSession(db, readSessionToken(request));
  return requireSuperAdmin(session);
}

export function adminAccountErrorResponse(error: unknown) {
  if (!(error instanceof AdminAccountServiceError)) return null;
  const status =
    error.code === "SUPER_ADMIN_REQUIRED"
      ? 403
      : error.code === "ADMIN_NOT_FOUND"
        ? 404
        : error.code.startsWith("DUPLICATE_")
          ? 409
          : 400;
  return NextResponse.json(
    {
      ok: false,
      message: error.message,
      ...(error.existingUserId ? { existingUserId: error.existingUserId } : {}),
    },
    { status },
  );
}

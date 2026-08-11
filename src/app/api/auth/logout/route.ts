import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import {
  authErrorResponse,
  readSessionToken,
  shouldUseSecureCookie,
} from "@/features/auth/route-utils";
import { revokeSession, SESSION_COOKIE_NAME } from "@/features/auth/session";
import { writeAuditLog } from "@/features/audit/audit-service";
import { prisma } from "@/lib/db/client";

type Dependencies = { db: PrismaClient; now?: () => Date };

export function createLogoutRoute(dependencies: Dependencies) {
  return async function handleLogout(request: Request): Promise<NextResponse> {
    try {
      assertSameOrigin(request);
      const token = readSessionToken(request);
      if (token) await revokeSession(dependencies.db, token, dependencies.now?.());
      await writeAuditLog(dependencies.db, {
        action: "AUTH_LOGOUT",
        result: "SUCCESS",
      });
      const response = NextResponse.json({ ok: true, redirectTo: "/login" });
      response.cookies.set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: shouldUseSecureCookie(request),
        expires: new Date(0),
      });
      return response;
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export async function POST(request: Request) {
  return createLogoutRoute({ db: prisma })(request);
}

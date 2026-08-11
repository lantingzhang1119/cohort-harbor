import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { login } from "@/features/auth/login-service";
import { assertSameOrigin } from "@/features/auth/origin";
import {
  authErrorResponse,
  shouldUseSecureCookie,
} from "@/features/auth/route-utils";
import { SESSION_COOKIE_NAME } from "@/features/auth/session";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});

type Dependencies = {
  db: PrismaClient;
  now?: () => Date;
  maxFailures?: number;
  lockMinutes?: number;
  sessionTtlHours?: number;
};

export function createLoginRoute(dependencies: Dependencies) {
  return async function handleLogin(request: Request): Promise<NextResponse> {
    try {
      assertSameOrigin(request);
      const input = inputSchema.parse(await request.json());
      const result = await login(input, dependencies);
      const redirectTo = result.user.mustChangePassword
        ? "/change-password"
        : result.user.role === Role.ADMIN || result.user.role === Role.SUPER_ADMIN
          ? "/admin"
          : "/employee";
      const response = NextResponse.json({ ok: true, redirectTo });
      response.cookies.set(SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: shouldUseSecureCookie(request),
        expires: result.sessionExpiresAt,
      });
      return response;
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { ok: false, message: "请输入姓名/工号和密码" },
          { status: 400 },
        );
      }
      return authErrorResponse(error);
    }
  };
}

export async function POST(request: Request) {
  return createLoginRoute({
    db: prisma,
    maxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
    lockMinutes: Number(process.env.LOGIN_LOCK_MINUTES ?? 15),
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  })(request);
}

import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { AuthError } from "@/features/auth/errors";
import { requireEmployeeViewAccess, requireSession } from "@/features/auth/guards";
import { requireEmployeeModule } from "@/features/employee-modules/module-guards";
import { SESSION_COOKIE_NAME } from "@/features/auth/session";

export function readSessionToken(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const item of cookieHeader.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export async function requireEmployeeModuleRequest(
  db: PrismaClient,
  request: Request,
  key: EmployeeModuleKey,
  now?: Date,
) {
  const session = await requireEmployeeViewRequest(db, request, now);
  await requireEmployeeModule(session, key, db);
  return session;
}

export async function requireEmployeeViewRequest(
  db: PrismaClient,
  request: Request,
  now?: Date,
) {
  const session = await requireSession(db, readSessionToken(request), now);
  requireEmployeeViewAccess(session);
  return session;
}

export function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json(
      {
        ok: false,
        ...(error.code === "PASSWORD_CHANGE_REQUIRED" ? { code: error.code } : {}),
        message: error.message,
      },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { ok: false, message: "请求未能完成，请稍后重试" },
    { status: 500 },
  );
}

export function shouldUseSecureCookie(request: Request): boolean {
  const url = new URL(request.url);
  return !(
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

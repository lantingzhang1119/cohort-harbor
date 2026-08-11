import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { requireAdmin, requireSession } from "@/features/auth/guards";
import { readSessionToken } from "@/features/auth/route-utils";
import { EmployeeServiceError } from "@/features/employees/employee-service";

export async function requireAdminRequest(db: PrismaClient, request: Request) {
  const session = await requireSession(db, readSessionToken(request));
  return requireAdmin(session);
}

export function employeeErrorResponse(error: unknown) {
  if (error instanceof EmployeeServiceError) {
    const status = error.code.startsWith("DUPLICATE_")
      ? 409
      : error.code === "FORBIDDEN"
        ? 403
      : error.code === "EMPLOYEE_NOT_FOUND"
        ? 404
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
  return null;
}

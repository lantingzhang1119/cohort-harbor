import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { resetEmployeePassword } from "@/features/employees/employee-service";
import { employeeErrorResponse, requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

export function createResetPasswordRoute(
  { db }: { db: PrismaClient },
  employeeId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const temporaryPassword = await resetEmployeePassword(db, employeeId, actor.id);
      return NextResponse.json({ ok: true, temporaryPassword });
    } catch (error) {
      return employeeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createResetPasswordRoute({ db: prisma }, id)(request);
}

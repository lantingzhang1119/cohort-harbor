import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { getEmployee, setEmployeesEnabled, updateEmployee } from "@/features/employees/employee-service";
import { employeeErrorResponse, requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

export function createEmployeeDetailRoute({ db }: { db: PrismaClient }, employeeId: string) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        const employee = await getEmployee(db, employeeId);
        return NextResponse.json({ ok: true, employee });
      } catch (error) {
        return employeeErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body.enabled === "boolean") {
          const count = await setEmployeesEnabled(db, [employeeId], body.enabled, actor.id);
          return NextResponse.json({ ok: true, count });
        }
        const employee = await updateEmployee(
          db,
          employeeId,
          body as Parameters<typeof updateEmployee>[2],
          actor.id,
        );
        return NextResponse.json({ ok: true, employee });
      } catch (error) {
        return employeeErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createEmployeeDetailRoute({ db: prisma }, id).GET(request);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createEmployeeDetailRoute({ db: prisma }, id).PATCH(request);
}

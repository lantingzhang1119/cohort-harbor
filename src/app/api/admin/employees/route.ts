import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { UserSource, WorkLocation } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { createEmployee, listEmployees } from "@/features/employees/employee-service";
import {
  employeeErrorResponse,
  requireAdminRequest,
} from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

type Dependencies = { db: PrismaClient };

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createEmployeesRoute(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(dependencies.db, request);
        const url = new URL(request.url);
        const locationText = url.searchParams.get("location") ?? undefined;
        const location = Object.values(WorkLocation).includes(locationText as WorkLocation)
          ? (locationText as WorkLocation)
          : undefined;
        const sourceText = url.searchParams.get("source") ?? undefined;
        const sourceType = Object.values(UserSource).includes(sourceText as UserSource)
          ? (sourceText as UserSource)
          : undefined;
        const enabledText = url.searchParams.get("enabled");
        const result = await listEmployees(dependencies.db, {
          query: url.searchParams.get("query") ?? undefined,
          department: url.searchParams.get("department") ?? undefined,
          location,
          sourceType,
          enabled:
            enabledText === null || enabledText === ""
              ? undefined
              : enabledText === "true",
          page: parsePositiveInt(url.searchParams.get("page")),
          pageSize: parsePositiveInt(url.searchParams.get("pageSize")),
        });
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(dependencies.db, request);
        const employee = await createEmployee(
          dependencies.db,
          (await request.json()) as Parameters<typeof createEmployee>[1],
          actor.id,
        );
        return NextResponse.json({ ok: true, employee }, { status: 201 });
      } catch (error) {
        return employeeErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const handlers = createEmployeesRoute({ db: prisma });
export const GET = handlers.GET;
export const POST = handlers.POST;

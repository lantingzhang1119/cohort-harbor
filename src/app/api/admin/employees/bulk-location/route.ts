import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { WorkLocation } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { bulkSetLocation } from "@/features/employees/employee-service";
import { employeeErrorResponse, requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  employeeIds: z.array(z.string().min(1)).min(1),
  location: z.enum(WorkLocation),
});

export function createBulkLocationRoute({ db }: { db: PrismaClient }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const input = inputSchema.parse(await request.json());
      const count = await bulkSetLocation(
        db,
        input.employeeIds,
        input.location,
        actor.id,
      );
      return NextResponse.json({ ok: true, count });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, message: "请选择员工和工作地点" }, { status: 400 });
      }
      return employeeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const POST = createBulkLocationRoute({ db: prisma });

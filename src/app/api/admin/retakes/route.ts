import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { RetakeStatus } from "@/generated/prisma/enums";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

export function createRetakesListRoute({ db }: { db: PrismaClient }) {
  return async function GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      const statusText = new URL(request.url).searchParams.get("status");
      const status = Object.values(RetakeStatus).find((value) => value === statusText);
      const applications = await db.retakeApplication.findMany({
        where: status ? { status } : undefined,
        include: {
          requester: { select: { name: true, employeeNo: true, firstDepartment: true } },
          assignment: { include: { exam: true, attempts: { orderBy: { attemptNo: "desc" } } } },
        },
        orderBy: { createdAt: "asc" },
      });
      return NextResponse.json({ ok: true, applications });
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export const GET = createRetakesListRoute({ db: prisma });

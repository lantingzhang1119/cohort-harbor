import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { runExamTaskMaintenance } from "@/features/exam-task-runtime/maintenance-service";
import { prisma } from "@/lib/db/client";

export function createExamTaskMaintenanceRoute(deps: { db: PrismaClient; now?: () => Date }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      await requireAdminRequest(deps.db, request);
      const result = await runExamTaskMaintenance(deps.db, deps.now?.());
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export const POST = createExamTaskMaintenanceRoute({ db: prisma });

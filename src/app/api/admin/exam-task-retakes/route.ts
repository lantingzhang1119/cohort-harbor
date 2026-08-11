import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { listPendingTaskRetakes } from "@/features/exam-task-runtime/retake-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdminTaskRetakesRoute(deps: { db: PrismaClient }) {
  return async function GET(request: Request) {
    try {
      const actor = await requireAdminRequest(deps.db, request);
      const applications = await listPendingTaskRetakes(deps.db, actor.id);
      return NextResponse.json({ ok: true, applications });
    } catch (error) {
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const GET = createAdminTaskRetakesRoute({ db: prisma });

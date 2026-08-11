import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { listExamTaskResultsForEmployee } from "@/features/exam-task-runtime/result-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

export function createEmployeeTaskResultsRoute(deps: { db: PrismaClient; now?: () => Date }) {
  return async function GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(
        deps.db,
        request,
        EmployeeModuleKey.RESULTS,
        deps.now?.(),
      );
      const assignments = await listExamTaskResultsForEmployee(
        deps.db,
        session.user.id,
        deps.now?.(),
      );
      return NextResponse.json({ ok: true, assignments });
    } catch (error) {
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const GET = createEmployeeTaskResultsRoute({ db: prisma });

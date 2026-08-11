import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { listExamTasksForEmployee } from "@/features/exam-task-runtime/task-query-service";
import { prisma } from "@/lib/db/client";

export function createEmployeeExamTasksRoute(deps: { db: PrismaClient; now?: () => Date }) {
  return async function GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(
        deps.db,
        request,
        EmployeeModuleKey.EXAM,
        deps.now?.(),
      );
      const tasks = await listExamTasksForEmployee(deps.db, session.user.id, deps.now?.());
      return NextResponse.json({ ok: true, tasks });
    } catch (error) {
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const GET = createEmployeeExamTasksRoute({ db: prisma });

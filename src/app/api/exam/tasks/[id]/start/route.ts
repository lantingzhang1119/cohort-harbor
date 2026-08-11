import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { startTaskAttempt } from "@/features/exam-task-runtime/attempt-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

export function createStartTaskAttemptRoute(
  deps: { db: PrismaClient; now?: () => Date },
  assignmentId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const session = await requireEmployeeModuleRequest(
        deps.db,
        request,
        EmployeeModuleKey.EXAM,
        deps.now?.(),
      );
      const attempt = await startTaskAttempt(
        deps.db,
        assignmentId,
        session.user.id,
        deps.now?.(),
      );
      return NextResponse.json({ ok: true, ...attempt });
    } catch (error) {
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createStartTaskAttemptRoute({ db: prisma }, id)(request);
}

import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { submitAttempt } from "@/features/exams/attempt-service";
import { attemptErrorResponse } from "@/features/exams/route-utils";
import { prisma } from "@/lib/db/client";

export function createSubmitRoute(
  dependencies: { db: PrismaClient; now?: () => Date },
  attemptId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const session = await requireEmployeeModuleRequest(dependencies.db, request, EmployeeModuleKey.EXAM, dependencies.now?.());
      const result = await submitAttempt(dependencies.db, attemptId, session.user.id, { now: dependencies.now?.() });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return attemptErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createSubmitRoute({ db: prisma }, id)(request);
}

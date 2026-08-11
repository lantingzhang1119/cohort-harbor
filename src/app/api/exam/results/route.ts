import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { listExamResultsForUser } from "@/features/exams/result-service";
import { prisma } from "@/lib/db/client";

export function createExamResultsRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.RESULTS);
      const assignments = await listExamResultsForUser(db, session.user.id);
      return NextResponse.json({ ok: true, assignments });
    } catch (error) {
      return authErrorResponse(error);
    }
  } };
}

export const GET = createExamResultsRoute({ db: prisma }).GET;

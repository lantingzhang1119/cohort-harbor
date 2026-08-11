import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { applyForRetake, RetakeServiceError } from "@/features/exams/retake-service";
import { prisma } from "@/lib/db/client";

export function createRetakesRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.RETAKE);
        const assignments = await db.examAssignment.findMany({ where: { userId: session.user.id }, include: { exam: true, retakeApplications: { orderBy: { createdAt: "desc" } } } });
        return NextResponse.json({ ok: true, assignments });
      } catch (error) { return authErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.RETAKE);
        const body = await request.json() as { assignmentId: string; reason: string };
        const application = await applyForRetake(db, body.assignmentId, session.user.id, body.reason);
        return NextResponse.json({ ok: true, application }, { status: 201 });
      } catch (error) {
        if (error instanceof RetakeServiceError) return NextResponse.json({ ok: false, message: error.message }, { status: 409 });
        return authErrorResponse(error);
      }
    },
  };
}

const route = createRetakesRoute({ db: prisma });
export const GET = route.GET;
export const POST = route.POST;

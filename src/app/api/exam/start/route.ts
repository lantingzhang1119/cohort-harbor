import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey, Role } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { findEnabledExamAssignment } from "@/features/exams/assignment-service";
import { AttemptServiceError, ensureAssignment, startAttempt } from "@/features/exams/attempt-service";
import { attemptErrorResponse } from "@/features/exams/route-utils";
import { prisma } from "@/lib/db/client";

export function createStartRoute(dependencies: { db: PrismaClient; now?: () => Date }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const session = await requireEmployeeModuleRequest(dependencies.db, request, EmployeeModuleKey.EXAM, dependencies.now?.());
      const isManagementAccount = session.user.role === Role.ADMIN || session.user.role === Role.SUPER_ADMIN;
      let assignment = await findEnabledExamAssignment(dependencies.db, session.user.id);
      if (!assignment && !isManagementAccount) {
        const exam = await dependencies.db.exam.findFirstOrThrow({
          where: { enabled: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        assignment = await ensureAssignment(
          dependencies.db,
          session.user.id,
          exam.id,
          dependencies.now?.(),
        );
      }
      if (!assignment) {
        throw new AttemptServiceError("ASSIGNMENT_NOT_FOUND", "当前管理账号暂无学习任务");
      }
      const attempt = await startAttempt(dependencies.db, assignment.id, session.user.id, { now: dependencies.now?.() });
      return NextResponse.json({ ok: true, ...attempt });
    } catch (error) {
      return attemptErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const POST = createStartRoute({ db: prisma });

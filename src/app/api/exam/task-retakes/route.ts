import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { applyForTaskRetake } from "@/features/exam-task-runtime/retake-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

const schema = z.object({ assignmentId: z.string().min(1), reason: z.string().min(10).max(2000) });

export function createTaskRetakeRoute(deps: { db: PrismaClient; now?: () => Date }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const session = await requireEmployeeModuleRequest(
        deps.db,
        request,
        EmployeeModuleKey.RETAKE,
        deps.now?.(),
      );
      const input = schema.parse(await request.json());
      const application = await applyForTaskRetake(
        deps.db,
        input.assignmentId,
        session.user.id,
        input.reason,
        deps.now?.(),
      );
      return NextResponse.json({ ok: true, application }, { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, message: "补考原因至少需要 10 个字符" }, { status: 400 });
      }
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export const POST = createTaskRetakeRoute({ db: prisma });

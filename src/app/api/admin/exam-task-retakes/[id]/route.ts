import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { reviewTaskRetake } from "@/features/exam-task-runtime/retake-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

const schema = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() });

export function createReviewTaskRetakeRoute(
  deps: { db: PrismaClient; now?: () => Date },
  applicationId: string,
) {
  return async function PATCH(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(deps.db, request);
      const input = schema.parse(await request.json());
      const application = await reviewTaskRetake(
        deps.db,
        applicationId,
        actor.id,
        input,
        deps.now?.(),
      );
      return NextResponse.json({ ok: true, application });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, message: "审批参数无效" }, { status: 400 });
      }
      return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createReviewTaskRetakeRoute({ db: prisma }, id)(request);
}

import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { setQuestionEnabled } from "@/features/exams/question-service";
import { prisma } from "@/lib/db/client";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const body = (await request.json()) as { enabled: boolean };
    const question = await setQuestionEnabled(prisma, id, Boolean(body.enabled), actor.id);
    return NextResponse.json({ ok: true, question });
  } catch (error) {
    return authErrorResponse(error);
  }
}

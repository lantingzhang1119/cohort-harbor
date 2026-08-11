import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { RetakeServiceError, reviewRetake } from "@/features/exams/retake-service";
import { prisma } from "@/lib/db/client";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const body = await request.json() as { approve: boolean; note?: string };
    const application = await reviewRetake(prisma, id, actor.id, body);
    return NextResponse.json({ ok: true, application });
  } catch (error) {
    if (error instanceof RetakeServiceError) return NextResponse.json({ ok: false, message: error.message }, { status: 409 });
    return authErrorResponse(error);
  }
}

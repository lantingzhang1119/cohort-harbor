import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { QuestionValidationError, updateExamSettings, validateEnabledExamScore } from "@/features/exams/question-service";
import { prisma } from "@/lib/db/client";

export async function GET(request: Request) {
  try {
    await requireAdminRequest(prisma, request);
    const [exam, setting] = await Promise.all([
      prisma.exam.findFirst({ where: { enabled: true } }),
      prisma.systemSetting.findUnique({ where: { id: "default" } }),
    ]);
    return NextResponse.json({ ok: true, exam, setting });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const body = (await request.json()) as Parameters<typeof updateExamSettings>[2] & { examId: string };
    await validateEnabledExamScore(prisma, body.examId);
    const exam = await updateExamSettings(prisma, body.examId, body, actor.id);
    return NextResponse.json({ ok: true, exam });
  } catch (error) {
    if (error instanceof QuestionValidationError) return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
    return authErrorResponse(error);
  }
}

import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { QuestionValidationError, upsertQuestion } from "@/features/exams/question-service";
import { prisma } from "@/lib/db/client";

export async function GET(request: Request) {
  try {
    await requireAdminRequest(prisma, request);
    const exam = await prisma.exam.findFirst({
      where: { enabled: true },
      include: { questions: { orderBy: { sequence: "asc" }, include: { options: { orderBy: { sortOrder: "asc" } } } } },
    });
    return NextResponse.json({ ok: true, exam });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const body = (await request.json()) as { examId: string; question: Parameters<typeof upsertQuestion>[2] };
    const question = await upsertQuestion(prisma, body.examId, body.question, actor.id);
    return NextResponse.json({ ok: true, question }, { status: 201 });
  } catch (error) {
    if (error instanceof QuestionValidationError) return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
    return authErrorResponse(error);
  }
}

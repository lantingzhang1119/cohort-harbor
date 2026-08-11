import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { getAttemptForUser, saveAnswer } from "@/features/exams/attempt-service";
import { attemptErrorResponse } from "@/features/exams/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({ questionId: z.string().min(1), selectedKeys: z.array(z.string().min(1)) });

export function createAnswerRoute(
  dependencies: { db: PrismaClient; now?: () => Date },
  attemptId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const session = await requireEmployeeModuleRequest(dependencies.db, request, EmployeeModuleKey.EXAM, dependencies.now?.());
      const input = inputSchema.parse(await request.json());
      const answer = await saveAnswer(dependencies.db, attemptId, session.user.id, input.questionId, input.selectedKeys, dependencies.now?.());
      return NextResponse.json({ ok: true, answer });
    } catch (error) {
      if (error instanceof z.ZodError) return NextResponse.json({ ok: false, message: "答案格式无效" }, { status: 400 });
      return attemptErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireEmployeeModuleRequest(prisma, request, EmployeeModuleKey.EXAM);
    const { id } = await context.params;
    const [attempt, setting] = await Promise.all([
      getAttemptForUser(prisma, id, session.user.id),
      prisma.systemSetting.findUnique({ where: { id: "default" }, select: { watermarkOpacity: true } }),
    ]);
    return NextResponse.json({ ok: true, ...attempt, watermarkName: session.user.name, watermarkOpacity: setting?.watermarkOpacity ?? 0.07 });
  } catch (error) {
    return attemptErrorResponse(error) ?? authErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAnswerRoute({ db: prisma }, id)(request);
}

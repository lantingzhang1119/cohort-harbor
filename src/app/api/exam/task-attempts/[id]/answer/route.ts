import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import {
  getTaskAttemptForUser,
  saveTaskAnswer,
} from "@/features/exam-task-runtime/attempt-service";
import { examTaskRuntimeErrorResponse } from "@/features/exam-task-runtime/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  questionId: z.string().min(1),
  response: z.union([
    z.object({ selectedOptionIds: z.array(z.string()) }),
    z.object({ values: z.array(z.string().max(1000)) }),
  ]),
});

type Deps = { db: PrismaClient; now?: () => Date };

async function requireExamSession(deps: Deps, request: Request) {
  return requireEmployeeModuleRequest(
    deps.db,
    request,
    EmployeeModuleKey.EXAM,
    deps.now?.(),
  );
}

export function createTaskAttemptAnswerRoute(deps: Deps, attemptId: string) {
  return {
    async GET(request: Request) {
      try {
        const session = await requireExamSession(deps, request);
        const [attempt, setting] = await Promise.all([
          getTaskAttemptForUser(deps.db, attemptId, session.user.id, deps.now?.()),
          deps.db.systemSetting.findUnique({
            where: { id: "default" },
            select: { watermarkOpacity: true },
          }),
        ]);
        return NextResponse.json({
          ok: true,
          ...attempt,
          watermarkName: session.user.name,
          watermarkOpacity: setting?.watermarkOpacity ?? 0.07,
        });
      } catch (error) {
        return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const session = await requireExamSession(deps, request);
        const input = inputSchema.parse(await request.json());
        const answer = await saveTaskAnswer(
          deps.db,
          attemptId,
          session.user.id,
          input.questionId,
          input.response,
          deps.now?.(),
        );
        return NextResponse.json({ ok: true, answer });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ ok: false, message: "答案格式无效" }, { status: 400 });
        }
        return examTaskRuntimeErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createTaskAttemptAnswerRoute({ db: prisma }, id).GET(request);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createTaskAttemptAnswerRoute({ db: prisma }, id).POST(request);
}

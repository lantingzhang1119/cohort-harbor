import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { toAdminQuestionDto } from "@/features/question-banks/dto";
import {
  createQuestionBankQuestion,
  reorderQuestionBankQuestions,
  type QuestionBankQuestionInput,
} from "@/features/question-banks/question-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

function parseQuestionInput(body: Record<string, unknown>): QuestionBankQuestionInput {
  return {
    type: body.type as QuestionBankQuestionType,
    prompt: String(body.prompt ?? ""),
    score: Number(body.score),
    enabled: Boolean(body.enabled ?? true),
    options: Array.isArray(body.options)
      ? (body.options as Array<{ label: string; text: string; isCorrect: boolean }>)
      : undefined,
    blanks: Array.isArray(body.blanks)
      ? (body.blanks as Array<{ blankIndex: number; acceptableAnswers: string[] }>)
      : undefined,
  };
}

export function createAdminQuestionBankQuestionsRoute(
  deps: RouteDeps = { db: prisma },
  bankId?: string,
) {
  return {
    async POST(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const body = (await request.json()) as Record<string, unknown>;

        if (Array.isArray(body.orderedQuestionIds)) {
          const questions = await reorderQuestionBankQuestions(
            deps.db,
            id,
            body.orderedQuestionIds as string[],
            actor.id,
          );
          return NextResponse.json({
            ok: true,
            questions: questions.map(toAdminQuestionDto),
          });
        }

        if (!Object.values(QuestionBankQuestionType).includes(body.type as QuestionBankQuestionType)) {
          return NextResponse.json({ ok: false, message: "题型无效" }, { status: 400 });
        }

        const question = await createQuestionBankQuestion(
          deps.db,
          id,
          parseQuestionInput(body),
          actor.id,
        );
        return NextResponse.json(
          { ok: true, question: toAdminQuestionDto(question) },
          { status: 201 },
        );
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankQuestionsRoute();
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.POST(request, context);

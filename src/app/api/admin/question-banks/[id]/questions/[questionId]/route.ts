import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { toAdminQuestionDto } from "@/features/question-banks/dto";
import {
  deleteQuestionBankQuestion,
  setQuestionBankQuestionEnabled,
  updateQuestionBankQuestion,
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

export function createAdminQuestionBankQuestionRoute(
  deps: RouteDeps = { db: prisma },
  bankId?: string,
  questionId?: string,
) {
  return {
    async PATCH(
      request: Request,
      context?: { params: Promise<{ id: string; questionId: string }> },
    ) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const params = context ? await context.params : { id: bankId!, questionId: questionId! };
        const body = (await request.json()) as Record<string, unknown>;

        if (body.enabled !== undefined && body.prompt === undefined && body.type === undefined) {
          const question = await setQuestionBankQuestionEnabled(
            deps.db,
            params.questionId,
            Boolean(body.enabled),
            actor.id,
            params.id,
          );
          return NextResponse.json({ ok: true, question: toAdminQuestionDto(question) });
        }

        if (
          body.type !== undefined &&
          !Object.values(QuestionBankQuestionType).includes(body.type as QuestionBankQuestionType)
        ) {
          return NextResponse.json({ ok: false, message: "题型无效" }, { status: 400 });
        }

        const question = await updateQuestionBankQuestion(
          deps.db,
          params.questionId,
          parseQuestionInput(body),
          actor.id,
          params.id,
        );
        return NextResponse.json({ ok: true, question: toAdminQuestionDto(question) });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async DELETE(
      request: Request,
      context?: { params: Promise<{ id: string; questionId: string }> },
    ) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const params = context ? await context.params : { id: bankId!, questionId: questionId! };
        await deleteQuestionBankQuestion(deps.db, params.questionId, actor.id, params.id);
        return NextResponse.json({ ok: true });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankQuestionRoute();
export const PATCH = (
  request: Request,
  context: { params: Promise<{ id: string; questionId: string }> },
) => route.PATCH(request, context);
export const DELETE = (
  request: Request,
  context: { params: Promise<{ id: string; questionId: string }> },
) => route.DELETE(request, context);

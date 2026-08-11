import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  QuestionBankImportError,
} from "@/features/question-banks/import/import-errors";
import {
  getQuestionBankImportJob,
  toImportJobDto,
  updateQuestionBankImportDraft,
} from "@/features/question-banks/import/import-service";
import type { DraftQuestionInput } from "@/features/question-banks/import/import-types";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient; privateRoot?: string };

function importErrorResponse(error: unknown) {
  if (error instanceof QuestionBankImportError) {
    const status = error.code === "NOT_FOUND" ? 404 : 400;
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status });
  }
  return questionBankErrorResponse(error);
}

export function createAdminQuestionBankImportJobRoute(
  deps: RouteDeps = { db: prisma },
  jobId: string,
) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireAdminRequest(deps.db, request);
        const job = await getQuestionBankImportJob(deps.db, jobId, actor.id);
        return NextResponse.json({ ok: true, job: toImportJobDto(job) });
      } catch (error) {
        return importErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const body = (await request.json()) as {
          bankName?: string;
          questions?: DraftQuestionInput[];
        };
        if (!body.questions) {
          return NextResponse.json({ ok: false, message: "缺少题目草稿" }, { status: 400 });
        }
        await updateQuestionBankImportDraft(deps.db, jobId, {
          actorId: actor.id,
          bankName: body.bankName,
          questions: body.questions,
        });
        const job = await getQuestionBankImportJob(deps.db, jobId, actor.id);
        return NextResponse.json({ ok: true, job: toImportJobDto(job) });
      } catch (error) {
        return importErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  return createAdminQuestionBankImportJobRoute({ db: prisma }, jobId).GET(request);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  return createAdminQuestionBankImportJobRoute({ db: prisma }, jobId).PATCH(request);
}

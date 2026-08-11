import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { QuestionBankImportError } from "@/features/question-banks/import/import-errors";
import { confirmQuestionBankImport } from "@/features/question-banks/import/import-service";
import { toAdminQuestionBankListItem } from "@/features/question-banks/dto";
import { getQuestionBankDetail } from "@/features/question-banks/question-bank-service";
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

export function createAdminQuestionBankImportConfirmRoute(
  deps: RouteDeps = { db: prisma },
  jobId: string,
) {
  return {
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const body = (await request.json().catch(() => ({}))) as {
          bankName?: string;
          description?: string | null;
        };
        const job = await confirmQuestionBankImport(deps.db, jobId, {
          actorId: actor.id,
          bankName: body.bankName,
          description: body.description,
        });
        if (!job.questionBankId) {
          return NextResponse.json({ ok: false, message: "确认失败" }, { status: 500 });
        }
        const bank = await getQuestionBankDetail(deps.db, job.questionBankId);
        return NextResponse.json({
          ok: true,
          job: {
            id: job.id,
            status: job.status,
            questionBankId: job.questionBankId,
          },
          bank: toAdminQuestionBankListItem(bank),
        });
      } catch (error) {
        return importErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  return createAdminQuestionBankImportConfirmRoute({ db: prisma }, jobId).POST(request);
}

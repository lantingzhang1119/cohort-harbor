import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  QuestionBankImportError,
  QuestionBankImportFileError,
} from "@/features/question-banks/import/import-errors";
import {
  getQuestionBankImportJob,
  startQuestionBankImport,
  toImportJobDto,
} from "@/features/question-banks/import/import-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type RouteDeps = { db: PrismaClient; privateRoot?: string };

function importErrorResponse(error: unknown) {
  if (error instanceof QuestionBankImportFileError || error instanceof QuestionBankImportError) {
    const status =
      error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 400;
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status });
  }
  return questionBankErrorResponse(error);
}

export function createAdminQuestionBankImportRoute(deps: RouteDeps = { db: prisma }) {
  const privateRoot = deps.privateRoot ?? defaultPrivateRoot;
  return {
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return NextResponse.json({ ok: false, message: "请选择题库文件" }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const job = await startQuestionBankImport(deps.db, {
          actorId: actor.id,
          privateRoot,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          bytes,
        });
        const detailed = await getQuestionBankImportJob(deps.db, job.id, actor.id);
        return NextResponse.json({ ok: true, job: toImportJobDto(detailed) }, { status: 201 });
      } catch (error) {
        return importErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankImportRoute();
export const POST = (request: Request) => route.POST(request);

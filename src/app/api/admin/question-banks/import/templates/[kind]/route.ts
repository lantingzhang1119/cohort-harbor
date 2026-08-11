import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  buildExcelTemplateBytes,
  buildWordTemplateBytes,
  getTemplateInstructionsMarkdown,
} from "@/features/question-banks/import/templates/template-files";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient; privateRoot?: string };
type TemplateKind = "word" | "excel" | "instructions";

function isTemplateKind(value: string): value is TemplateKind {
  return value === "word" || value === "excel" || value === "instructions";
}

export function createAdminQuestionBankImportTemplatesRoute(
  deps: RouteDeps = { db: prisma },
  kind: string,
) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(deps.db, request);
        if (!isTemplateKind(kind)) {
          return NextResponse.json({ ok: false, message: "未知模板类型" }, { status: 404 });
        }
        if (kind === "instructions") {
          const body = getTemplateInstructionsMarkdown();
          return new NextResponse(body, {
            status: 200,
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": 'attachment; filename="question-bank-template-instructions.md"',
              "content-length": String(Buffer.byteLength(body, "utf8")),
              "cache-control": "no-store",
            },
          });
        }
        if (kind === "excel") {
          const bytes = buildExcelTemplateBytes();
          return new NextResponse(Buffer.from(bytes), {
            status: 200,
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "content-disposition": 'attachment; filename="question-bank-template.xlsx"',
              "content-length": String(bytes.byteLength),
              "cache-control": "no-store",
            },
          });
        }
        const bytes = buildWordTemplateBytes();
        return new NextResponse(Buffer.from(bytes), {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "content-disposition": 'attachment; filename="question-bank-template.docx"',
            "content-length": String(bytes.byteLength),
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
) {
  const { kind } = await context.params;
  return createAdminQuestionBankImportTemplatesRoute({ db: prisma }, kind).GET(request);
}

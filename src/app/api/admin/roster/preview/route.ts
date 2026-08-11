import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { ImportBatchStatus } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { ExcelRosterSource, RosterFileError } from "@/features/roster/excel-roster-source";
import { stageRosterImport } from "@/features/roster/import-commit-service";
import { prisma } from "@/lib/db/client";

export function createRosterPreviewRoute({ db }: { db: PrismaClient }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, message: "请选择 Excel 文件" }, { status: 400 });
      }
      const source = new ExcelRosterSource();
      const input = {
        fileName: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
      const [rows, metadata] = await Promise.all([
        source.load(input),
        source.createBatchMetadata(input),
      ]);
      const staged = await stageRosterImport(db, { rows, metadata, actorId: actor.id });
      return NextResponse.json({ ok: true, ...staged }, { status: 201 });
    } catch (error) {
      if (error instanceof RosterFileError) {
        return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status: 400 });
      }
      return authErrorResponse(error);
    }
  };
}

export const POST = createRosterPreviewRoute({ db: prisma });

export function createRosterHistoryRoute({ db }: { db: PrismaClient }) {
  return async function GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      const statusText = new URL(request.url).searchParams.get("status");
      const status = Object.values(ImportBatchStatus).find((value) => value === statusText);
      const batches = await db.rosterImportBatch.findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          originalFileName: true,
          status: true,
          totalRows: true,
          createdCount: true,
          updatedCount: true,
          disabledCount: true,
          conflictCount: true,
          createdAt: true,
          committedAt: true,
        },
      });
      return NextResponse.json({ ok: true, batches });
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export const GET = createRosterHistoryRoute({ db: prisma });

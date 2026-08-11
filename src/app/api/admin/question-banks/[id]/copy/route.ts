import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { toAdminQuestionBankListItem } from "@/features/question-banks/dto";
import { copyQuestionBank } from "@/features/question-banks/question-bank-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminQuestionBankCopyRoute(
  deps: RouteDeps = { db: prisma },
  bankId?: string,
) {
  return {
    async POST(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const body = (await request.json().catch(() => ({}))) as { name?: string };
        const bank = await copyQuestionBank(deps.db, id, actor.id, { name: body.name });
        return NextResponse.json(
          { ok: true, bank: toAdminQuestionBankListItem(bank) },
          { status: 201 },
        );
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankCopyRoute();
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.POST(request, context);

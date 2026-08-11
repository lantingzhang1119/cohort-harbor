import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { toAdminQuestionBankListItem } from "@/features/question-banks/dto";
import { setDefaultQuestionBank } from "@/features/question-banks/question-bank-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminQuestionBankDefaultRoute(
  deps: RouteDeps = { db: prisma },
  bankId?: string,
) {
  return {
    async POST(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const bank = await setDefaultQuestionBank(deps.db, id, actor.id);
        return NextResponse.json({ ok: true, bank: toAdminQuestionBankListItem(bank) });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankDefaultRoute();
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.POST(request, context);

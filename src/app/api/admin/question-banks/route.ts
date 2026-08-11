import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { toAdminQuestionBankListItem } from "@/features/question-banks/dto";
import {
  createBlankQuestionBank,
  listQuestionBanks,
} from "@/features/question-banks/question-bank-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminQuestionBanksRoute(deps: RouteDeps = { db: prisma }) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(deps.db, request);
        const banks = await listQuestionBanks(deps.db);
        return NextResponse.json({
          ok: true,
          banks: banks.map(toAdminQuestionBankListItem),
        });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const body = (await request.json()) as { name?: string; description?: string | null };
        const bank = await createBlankQuestionBank(deps.db, {
          name: body.name ?? "",
          description: body.description,
          actorId: actor.id,
        });
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

const route = createAdminQuestionBanksRoute();
export const GET = (request: Request) => route.GET(request);
export const POST = (request: Request) => route.POST(request);

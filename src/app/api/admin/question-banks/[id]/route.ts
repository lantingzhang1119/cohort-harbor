import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { QuestionBankStatus } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  toAdminQuestionBankDetail,
  toAdminQuestionBankListItem,
} from "@/features/question-banks/dto";
import {
  getQuestionBankDetail,
  setQuestionBankStatus,
  softDeleteQuestionBank,
  updateQuestionBankMeta,
} from "@/features/question-banks/question-bank-service";
import { questionBankErrorResponse } from "@/features/question-banks/route-utils";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminQuestionBankRoute(deps: RouteDeps = { db: prisma }, bankId?: string) {
  return {
    async GET(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const bank = await getQuestionBankDetail(deps.db, id);
        return NextResponse.json({
          ok: true,
          bank: toAdminQuestionBankDetail(bank),
        });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async PATCH(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const body = (await request.json()) as {
          name?: string;
          description?: string | null;
          status?: QuestionBankStatus;
        };

        if (body.status !== undefined) {
          if (!Object.values(QuestionBankStatus).includes(body.status)) {
            return NextResponse.json({ ok: false, message: "题库状态无效" }, { status: 400 });
          }
          await setQuestionBankStatus(deps.db, id, body.status, actor.id);
        }
        if (body.name !== undefined || body.description !== undefined) {
          await updateQuestionBankMeta(deps.db, id, {
            name: body.name,
            description: body.description,
            actorId: actor.id,
          });
        }

        const bank = await getQuestionBankDetail(deps.db, id);
        return NextResponse.json({
          ok: true,
          bank: toAdminQuestionBankDetail(bank),
        });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async DELETE(request: Request, context?: { params: Promise<{ id: string }> }) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const id = bankId ?? (await context!.params).id;
        const bank = await softDeleteQuestionBank(deps.db, id, actor.id);
        return NextResponse.json({
          ok: true,
          bank: toAdminQuestionBankListItem(bank),
        });
      } catch (error) {
        return questionBankErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminQuestionBankRoute();
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.GET(request, context);
export const PATCH = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.PATCH(request, context);
export const DELETE = (request: Request, context: { params: Promise<{ id: string }> }) =>
  route.DELETE(request, context);

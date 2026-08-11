import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { examTaskErrorResponse } from "@/features/exam-tasks/route-utils";
import { getSelectableQuestionBanksForPublish } from "@/features/exam-tasks/selectable-banks-service";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminExamTaskSelectableBanksRoute(
  deps: RouteDeps = { db: prisma },
) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(deps.db, request);
        const result = await getSelectableQuestionBanksForPublish(deps.db);
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return examTaskErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminExamTaskSelectableBanksRoute();
export const GET = (request: Request) => route.GET(request);

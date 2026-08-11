import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { publishExamTask } from "@/features/exam-tasks/publish-service";
import { examTaskErrorResponse } from "@/features/exam-tasks/route-utils";
import type { PublishExamTaskInput } from "@/features/exam-tasks/schemas";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminExamTasksRoute(deps: RouteDeps = { db: prisma }) {
  return {
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(deps.db, request);
        const body = (await request.json()) as PublishExamTaskInput;
        const task = await publishExamTask(deps.db, body, actor.id);
        return NextResponse.json(
          { ok: true, task },
          { status: task.replayed ? 200 : 201 },
        );
      } catch (error) {
        return examTaskErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminExamTasksRoute();
export const POST = (request: Request) => route.POST(request);

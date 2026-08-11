import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { SessionViewMode } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, readSessionToken } from "@/features/auth/route-utils";
import { switchSessionViewMode } from "@/features/auth/view-mode-service";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  targetMode: z.enum([SessionViewMode.ADMIN, SessionViewMode.EMPLOYEE]),
});

export function createViewModeRoute({ db }: { db: PrismaClient }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const input = inputSchema.parse(await request.json());
      const result = await switchSessionViewMode(
        db,
        readSessionToken(request),
        input.targetMode,
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { ok: false, message: "请选择有效的视图" },
          { status: 400 },
        );
      }
      return authErrorResponse(error);
    }
  };
}

export const POST = createViewModeRoute({ db: prisma });

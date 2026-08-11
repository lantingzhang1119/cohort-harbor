import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { Role, SessionViewMode } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import {
  InvalidDisplayNameError,
  updateOwnDisplayName,
} from "@/features/auth/real-name";
import { requireSession } from "@/features/auth/guards";
import { authErrorResponse, readSessionToken } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  name: z.string().max(160),
}).strict();

export function createProfileRoute({ db }: { db: PrismaClient }) {
  return async function PATCH(request: Request): Promise<NextResponse> {
    try {
      assertSameOrigin(request);
      const input = inputSchema.parse(await request.json());
      const session = await requireSession(db, readSessionToken(request));
      if (session.user.role !== Role.ADMIN && session.user.role !== Role.SUPER_ADMIN) {
        return NextResponse.json({ ok: false, message: "员工姓名请由管理员在花名册中维护" }, { status: 403 });
      }
      const result = await updateOwnDisplayName(
        { actorId: session.user.id, name: input.name },
        db,
      );
      return NextResponse.json({
        ok: true,
        ...result,
        redirectTo:
          session.viewMode === SessionViewMode.ADMIN ? "/admin/settings" : "/employee",
      });
    } catch (error) {
      if (error instanceof InvalidDisplayNameError) {
        return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, message: "请输入有效姓名" }, { status: 400 });
      }
      return authErrorResponse(error);
    }
  };
}

export const PATCH = createProfileRoute({ db: prisma });

import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { ConflictResolution } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { newPasswordSchema } from "@/features/auth/password-policy";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { commitRosterImport, RosterCommitError } from "@/features/roster/import-commit-service";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  batchId: z.string().min(1),
  decisions: z.array(
    z.object({
      conflictId: z.string().min(1),
      resolution: z.enum(ConflictResolution),
    }),
  ),
  temporaryPassword: newPasswordSchema.optional(),
});

export function createRosterCommitRoute({ db }: { db: PrismaClient }) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const input = inputSchema.parse(await request.json());
      const result = await commitRosterImport(db, { ...input, actorId: actor.id });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, message: "导入提交参数无效" }, { status: 400 });
      }
      if (error instanceof RosterCommitError) {
        return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status: 409 });
      }
      return authErrorResponse(error);
    }
  };
}

export const POST = createRosterCommitRoute({ db: prisma });

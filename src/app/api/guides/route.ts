import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { listGuidesForEmployee } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

export function createGuidesRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.GUIDES);
      const guides = await listGuidesForEmployee(db, session.user.id);
      return NextResponse.json({ ok: true, guides });
    } catch (error) {
      return authErrorResponse(error);
    }
  } };
}

export const GET = createGuidesRoute({ db: prisma }).GET;

import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { listPoliciesForEmployee } from "@/features/policies/policy-service";
import { prisma } from "@/lib/db/client";

export function createPoliciesRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.POLICIES);
      const [policies, setting] = await Promise.all([
        listPoliciesForEmployee(db, session.user.id),
        db.systemSetting.findUnique({ where: { id: "default" }, select: { watermarkOpacity: true } }),
      ]);
      return NextResponse.json({ ok: true, policies, watermarkName: session.user.name, watermarkOpacity: setting?.watermarkOpacity ?? 0.07 });
    } catch (error) {
      return authErrorResponse(error);
    }
  } };
}

export const GET = createPoliciesRoute({ db: prisma }).GET;

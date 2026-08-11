import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { City, EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { getGuideForEmployee } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

export function createGuideRoute({ db }: { db: PrismaClient }) {
  return async function GET(request: Request, cityText: string) {
    try {
      const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.GUIDES);
      if (!Object.values(City).includes(cityText as City)) {
        return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
      }
      const [guide, setting] = await Promise.all([
        getGuideForEmployee(db, session.user.id, cityText as City),
        db.systemSetting.findUnique({ where: { id: "default" }, select: { watermarkOpacity: true } }),
      ]);
      return NextResponse.json({
        ok: true,
        guide,
        watermarkName: session.user.name,
        watermarkOpacity: setting?.watermarkOpacity ?? 0.07,
      });
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export async function GET(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  return createGuideRoute({ db: prisma })(request, city);
}

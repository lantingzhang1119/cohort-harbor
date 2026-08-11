import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { City, EmployeeModuleKey } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { getPublishedPortal } from "@/features/portal/portal-service";
import { portalViewportSchema } from "@/features/portal/portal-schemas";
import { prisma } from "@/lib/db/client";

export function createEmployeePortalRoute({ db }: { db: PrismaClient }, city: City) {
  return async function GET(request: Request) {
    try {
      await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.GUIDES);
      const guideVisible = await db.cityGuide.count({ where: { city, enabled: true } });
      if (!guideVisible) {
        return NextResponse.json({ ok: false, message: "城市指南当前未开放" }, { status: 404 });
      }
      const viewport = portalViewportSchema.parse(new URL(request.url).searchParams.get("viewport"));
      return NextResponse.json({ ok: true, portal: await getPublishedPortal(db, city, viewport) });
    } catch (error) {
      return portalErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function GET(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!Object.values(City).includes(city as City)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createEmployeePortalRoute({ db: prisma }, city as City)(request);
}

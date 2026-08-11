import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { City } from "@/generated/prisma/enums";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { listPortalHistory } from "@/features/portal/portal-service";
import { prisma } from "@/lib/db/client";

export function createPortalHistoryRoute({ db }: { db: PrismaClient }, city: City) {
  return async function GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      return NextResponse.json({
        ok: true,
        history: await listPortalHistory(db, city),
      });
    } catch (error) {
      return portalErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ city: string }> },
) {
  const { city } = await context.params;
  if (!Object.values(City).includes(city as City)) {
    return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  }
  return createPortalHistoryRoute({ db: prisma }, city as City)(request);
}

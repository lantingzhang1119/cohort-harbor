import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createNotificationsRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.NOTIFICATIONS);
        const notifications = await db.notification.findMany({
          where: { userId: session.user.id },
          orderBy: { createdAt: "desc" },
        });
        return NextResponse.json({ ok: true, notifications });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const session = await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.NOTIFICATIONS);
        const body = (await request.json()) as { id?: string };
        if (!body.id) {
          return NextResponse.json({ ok: false, message: "通知标识无效" }, { status: 400 });
        }
        const changed = await db.notification.updateMany({
          where: { id: body.id, userId: session.user.id, readAt: null },
          data: { readAt: new Date() },
        });
        return NextResponse.json({ ok: true, changed: changed.count });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  };
}

const route = createNotificationsRoute({ db: prisma });
export const GET = route.GET;
export const PATCH = route.PATCH;

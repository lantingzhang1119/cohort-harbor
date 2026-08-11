import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { City, PortalViewport } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { readBoundedJson } from "@/features/portal/portal-request-body";
import { restorePortalPublication, restorePreviousPublication } from "@/features/portal/portal-service";
import { prisma } from "@/lib/db/client";

const restoreSchema = z.object({
  viewport: z.enum([PortalViewport.DESKTOP, PortalViewport.MOBILE]),
  version: z.number().int().positive().optional(),
}).strict();

const restoreSceneSchema = z.object({
  viewport: z.enum([PortalViewport.DESKTOP, PortalViewport.MOBILE]),
  version: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
}).strict();

export function createPortalRestoreRoute({ db }: { db: PrismaClient }, city: City) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const body = await readBoundedJson(request);
      const draft = typeof body === "object" && body !== null && "revision" in body
        ? await (async () => {
            const input = restoreSceneSchema.parse(body);
            return restorePortalPublication(
              db,
              city,
              input.viewport,
              input.version,
              input.revision,
              actor.id,
            );
          })()
        : await (async () => {
            const input = restoreSchema.parse(body);
            return restorePreviousPublication(db, city, input.viewport, actor.id, input.version);
          })();
      return NextResponse.json({ ok: true, draft });
    } catch (error) {
      return portalErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!Object.values(City).includes(city as City)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalRestoreRoute({ db: prisma }, city as City)(request);
}

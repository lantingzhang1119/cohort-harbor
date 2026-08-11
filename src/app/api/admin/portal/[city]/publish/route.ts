import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { readBoundedJson } from "@/features/portal/portal-request-body";
import { publishPortal, publishPortalScenes } from "@/features/portal/portal-service";
import { prisma } from "@/lib/db/client";

const scenePublishSchema = z.union([
  z.object({
    revisions: z.object({
      desktop: z.number().int().nonnegative(),
      mobile: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({
    desktopRevision: z.number().int().nonnegative(),
    mobileRevision: z.number().int().nonnegative(),
  }).strict(),
]);

export function createPortalPublishRoute({ db }: { db: PrismaClient }, city: City) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const body = await readBoundedJson(request);
      const isV1 = typeof body === "object"
        && body !== null
        && ("revisions" in body || "desktopRevision" in body);
      const result = isV1
        ? await (async () => {
            const input = scenePublishSchema.parse(body);
            const revisions = "revisions" in input
              ? input.revisions
              : { desktop: input.desktopRevision, mobile: input.mobileRevision };
            return publishPortalScenes(db, city, revisions, actor.id);
          })()
        : await (async () => {
            z.object({}).strict().parse(body);
            return publishPortal(db, city, actor.id);
          })();
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    } catch (error) {
      return portalErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!Object.values(City).includes(city as City)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalPublishRoute({ db: prisma }, city as City)(request);
}

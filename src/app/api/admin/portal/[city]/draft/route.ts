import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { City, PortalViewport } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { readBoundedJson } from "@/features/portal/portal-request-body";
import {
  confirmMobileSceneReview,
  copyDesktopDraftToMobile,
  copyDesktopSceneToMobile,
  getPortalDraft,
  savePortalDraft,
  savePortalSceneDraft,
} from "@/features/portal/portal-service";
import { portalDraftSaveSchema, portalViewportSchema } from "@/features/portal/portal-schemas";
import { prisma } from "@/lib/db/client";

const sceneDraftSaveSchema = z.object({
  viewport: z.enum([PortalViewport.DESKTOP, PortalViewport.MOBILE]),
  revision: z.number().int().nonnegative(),
  scene: z.unknown(),
}).strict();

const copySceneSchema = z.union([
  z.object({
    action: z.literal("COPY_DESKTOP_TO_MOBILE"),
    desktopRevision: z.number().int().nonnegative(),
    mobileRevision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    action: z.literal("COPY_DESKTOP_TO_MOBILE"),
    revisions: z.object({
      desktop: z.number().int().nonnegative(),
      mobile: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
]);

const confirmMobileSchema = z.object({
  action: z.literal("CONFIRM_MOBILE_REVIEW"),
  revision: z.number().int().nonnegative(),
}).strict();

const legacyCopySchema = z.object({
  action: z.literal("COPY_DESKTOP_TO_MOBILE"),
}).strict();

export function createPortalDraftRoute({ db }: { db: PrismaClient }, city: City) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        const viewport = portalViewportSchema.parse(new URL(request.url).searchParams.get("viewport"));
        return NextResponse.json({ ok: true, draft: await getPortalDraft(db, city, viewport) });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const body = await readBoundedJson(request);
        const draft = typeof body === "object" && body !== null && "scene" in body
          ? await (async () => {
              const input = sceneDraftSaveSchema.parse(body);
              return savePortalSceneDraft(db, city, input.viewport, input.scene, input.revision, actor.id);
            })()
          : await (async () => {
              const input = portalDraftSaveSchema.parse(body);
              return savePortalDraft(db, city, input.viewport, input.elements, actor.id);
            })();
        return NextResponse.json({ ok: true, draft });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const body = await readBoundedJson(request);
        if (typeof body !== "object" || body === null || !("action" in body)) {
          return NextResponse.json({ ok: false, message: "未知草稿操作" }, { status: 400 });
        }
        if (body.action === "CONFIRM_MOBILE_REVIEW") {
          const input = confirmMobileSchema.parse(body);
          const draft = await confirmMobileSceneReview(db, city, input.revision, actor.id);
          return NextResponse.json({ ok: true, draft });
        }
        if (body.action !== "COPY_DESKTOP_TO_MOBILE") {
          return NextResponse.json({ ok: false, message: "未知草稿操作" }, { status: 400 });
        }
        const hasV1Revisions = "desktopRevision" in body
          || "mobileRevision" in body
          || "revisions" in body;
        const draft = hasV1Revisions
          ? await (async () => {
              const input = copySceneSchema.parse(body);
              const revisions = "revisions" in input
                ? input.revisions
                : { desktop: input.desktopRevision, mobile: input.mobileRevision };
              return copyDesktopSceneToMobile(db, city, revisions, actor.id);
            })()
          : await (async () => {
              legacyCopySchema.parse(body);
              return copyDesktopDraftToMobile(db, city, actor.id);
            })();
        return NextResponse.json({ ok: true, draft });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

function validCity(value: string): value is City { return Object.values(City).includes(value as City); }

export async function GET(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalDraftRoute({ db: prisma }, city).GET(request);
}
export async function PATCH(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalDraftRoute({ db: prisma }, city).PATCH(request);
}
export async function POST(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalDraftRoute({ db: prisma }, city).POST(request);
}

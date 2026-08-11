import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailTemplateKind } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { saveTemplateDraftWithSettings } from "@/features/onboarding-mail/template-service";
import { templateDraftSchema } from "@/features/onboarding-mail/template-schemas";
import { prisma } from "@/lib/db/client";

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });
const updateSchema = z.object({ draft: templateDraftSchema, enabled: z.boolean(), defaultSendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) });

export function createOnboardingMailTemplatesRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        const template = await db.onboardingMailTemplate.findUnique({
          where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
          include: { draftAttachments: { orderBy: { sortOrder: "asc" } }, draftCcEntries: { orderBy: { sortOrder: "asc" } }, currentRevision: true },
        });
        return NextResponse.json({ ok: true, template });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const input = createSchema.parse(await request.json());
        const template = await db.onboardingMailTemplate.upsert({
          where: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME },
          create: { kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: input.name, updatedById: actor.id, updatedBySnapshot: snapshotUserIdentity(actor) },
          update: { name: input.name, updatedById: actor.id, updatedBySnapshot: snapshotUserIdentity(actor) },
        });
        return NextResponse.json({ ok: true, template }, { status: 201 });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const input = updateSchema.parse(await request.json());
        const saved = await saveTemplateDraftWithSettings(actor.id, input.draft, {
          enabled: input.enabled,
          defaultSendTime: input.defaultSendTime,
        }, { db });
        const template = await db.onboardingMailTemplate.findUniqueOrThrow({
          where: { id: saved.id },
          include: { draftAttachments: { orderBy: { sortOrder: "asc" } }, draftCcEntries: { orderBy: { sortOrder: "asc" } }, currentRevision: true },
        });
        return NextResponse.json({ ok: true, template });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
  };
}
const route = createOnboardingMailTemplatesRoute({ db: prisma });
export const GET = route.GET;
export const POST = route.POST;
export const PATCH = route.PATCH;

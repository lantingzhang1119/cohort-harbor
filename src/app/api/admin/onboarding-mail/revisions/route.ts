import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { publishTemplate } from "@/features/onboarding-mail/template-service";
import { templateDraftSchema } from "@/features/onboarding-mail/template-schemas";
import { prisma } from "@/lib/db/client";

const schema = z.object({
  draft: templateDraftSchema,
  confirmed: z.literal(true),
  enabled: z.boolean().optional(),
  defaultSendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).refine((input) => (input.enabled === undefined) === (input.defaultSendTime === undefined), {
  message: "模板启用状态与发送时间必须同时提交",
});
export function createOnboardingMailRevisionsRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        const templateId = new URL(request.url).searchParams.get("templateId");
        if (!templateId) return NextResponse.json({ ok: false, code: "VALIDATION_ERROR", message: "缺少模板 ID" }, { status: 400 });
        const revisions = await db.onboardingMailTemplateRevision.findMany({ where: { templateId }, include: { attachments: true, ccEntries: true }, orderBy: { revisionNumber: "desc" } });
        return NextResponse.json({ ok: true, revisions });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const input = schema.parse(await request.json());
        const settings = input.enabled === undefined ? undefined : {
          enabled: input.enabled,
          defaultSendTime: input.defaultSendTime!,
        };
        const revision = await publishTemplate(actor.id, input.draft, { db }, settings);
        return NextResponse.json({ ok: true, revision }, { status: 201 });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
  };
}
const route = createOnboardingMailRevisionsRoute({ db: prisma });
export const GET = route.GET;
export const POST = route.POST;

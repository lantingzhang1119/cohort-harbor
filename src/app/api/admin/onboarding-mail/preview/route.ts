import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { previewWelcomeTemplate } from "@/features/onboarding-mail/template-service";
import { templateDraftSchema } from "@/features/onboarding-mail/template-schemas";
import { prisma } from "@/lib/db/client";

const schema = z.object({ draft: templateDraftSchema, employeeId: z.string().min(1) });
export function createOnboardingMailPreviewRoute({ db, now }: { db: PrismaClient; now: () => Date }) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const input = schema.parse(await request.json());
      const preview = await previewWelcomeTemplate(actor.id, input.draft, input.employeeId, { db, now: now() });
      return NextResponse.json({ ok: true, preview });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
const route = createOnboardingMailPreviewRoute({ db: prisma, now: () => new Date() });
export const POST = route.POST;

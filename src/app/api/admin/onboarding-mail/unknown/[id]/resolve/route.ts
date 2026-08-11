import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { resolveUnknownDelivery } from "@/features/onboarding-mail/delivery-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";

const schema = z.object({ action: z.enum(["CONFIRMED_DELIVERED", "CONFIRMED_FAILED_RESEND"]), note: z.string().trim().min(1).max(500), confirmed: z.literal(true) });
export function createOnboardingMailUnknownResolutionRoute({ db, now }: { db: PrismaClient; now: () => Date }, id: string) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const input = schema.parse(await request.json());
      const result = await resolveUnknownDelivery(id, { resolution: input.action, resolverId: actor.id, note: input.note }, { db, now });
      return NextResponse.json({ ok: true, result }, { status: result.resendDeliveryId ? 201 : 200 });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createOnboardingMailUnknownResolutionRoute({ db: prisma, now: () => new Date() }, id).POST(request);
}

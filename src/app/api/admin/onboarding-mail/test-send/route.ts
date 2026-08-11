import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { createExplicitTestDelivery } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";

const schema = z.object({ employeeId: z.string().min(1), templateRevisionId: z.string().min(1), testMailbox: z.string().trim().email(), confirmed: z.literal(true) });
export function createOnboardingMailTestSendRoute({ db, now }: { db: PrismaClient; now: () => Date }) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const input = schema.parse(await request.json());
      const delivery = await createExplicitTestDelivery({ db, actorId: actor.id, ...input, now: now() });
      return NextResponse.json({ ok: true, delivery: { id: delivery.id, status: delivery.status, testMailbox: delivery.recipientEmailSnapshot } }, { status: 201 });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
const route = createOnboardingMailTestSendRoute({ db: prisma, now: () => new Date() });
export const POST = route.POST;

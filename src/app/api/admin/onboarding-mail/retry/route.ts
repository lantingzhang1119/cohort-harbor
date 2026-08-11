import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { retryFailedDeliveries } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";

const schema = z.object({ deliveryIds: z.array(z.string().min(1)).min(1).max(100), confirmed: z.literal(true) });
export function createOnboardingMailRetryRoute({ db, now }: { db: PrismaClient; now: () => Date }) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      await requireAdminRequest(db, request);
      const input = schema.parse(await request.json());
      const result = await retryFailedDeliveries(db, input.deliveryIds, now());
      return NextResponse.json({ ok: true, retried: result.count });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
const route = createOnboardingMailRetryRoute({ db: prisma, now: () => new Date() });
export const POST = route.POST;

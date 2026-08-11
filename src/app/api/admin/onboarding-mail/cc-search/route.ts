import { NextResponse } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { searchCcCandidates } from "@/features/onboarding-mail/cc-service";
import { prisma } from "@/lib/db/client";

export function createOnboardingMailCcSearchRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      const query = new URL(request.url).searchParams.get("q") ?? "";
      return NextResponse.json({ ok: true, candidates: await searchCcCandidates(query, { db }) });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
const route = createOnboardingMailCcSearchRoute({ db: prisma });
export const GET = route.GET;

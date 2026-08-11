import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { publishMaterial } from "@/features/onboarding-kit/material-service";
import { onboardingErrorResponse } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export function createAdminMaterialPublishRoute({ db }: { db: PrismaClient }, materialId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(db, request);
      const material = await publishMaterial(actor.id, materialId, { db, privateRoot: defaultPrivateRoot, maxBytes: 0 });
      return NextResponse.json({ ok: true, material });
    } catch (error) { return onboardingErrorResponse(error); }
  };
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createAdminMaterialPublishRoute({ db: prisma }, (await context.params).id)(request); }

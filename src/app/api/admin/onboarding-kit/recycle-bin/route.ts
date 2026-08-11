import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { listMaterialRecycleBin } from "@/features/onboarding-kit/material-recycle-service";
import { MAX_ONBOARDING_FILE_BYTES, onboardingErrorResponse } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string; maxBytes: number };

export function createAdminMaterialRecycleBinRoute(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireAdminRequest(dependencies.db, request);
        const bin = await listMaterialRecycleBin(actor.id, dependencies);
        return NextResponse.json({ ok: true, ...bin });
      } catch (error) {
        return contentRecycleErrorResponse(error) ?? onboardingErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminMaterialRecycleBinRoute({
  db: prisma,
  privateRoot: defaultPrivateRoot,
  maxBytes: MAX_ONBOARDING_FILE_BYTES,
});
export const GET = route.GET;

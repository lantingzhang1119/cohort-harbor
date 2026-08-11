import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { listPolicyRecycleBin } from "@/features/policies/policy-recycle-service";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot?: string };

export function createAdminPolicyRecycleBinRoute(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        const actor = await requireAdminRequest(dependencies.db, request);
        const bin = await listPolicyRecycleBin(dependencies.db, actor.id);
        return NextResponse.json({ ok: true, ...bin });
      } catch (error) {
        return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminPolicyRecycleBinRoute({ db: prisma, privateRoot: defaultPrivateRoot });
export const GET = route.GET;

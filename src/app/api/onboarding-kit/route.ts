import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey, OnboardingMaterialStatus } from "@/generated/prisma/enums";
import { authErrorResponse, requireEmployeeModuleRequest } from "@/features/auth/route-utils";
import { prisma } from "@/lib/db/client";

export function createOnboardingKitRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      await requireEmployeeModuleRequest(db, request, EmployeeModuleKey.ONBOARDING_KIT);
      const items = await db.onboardingMaterial.findMany({
        where: {
          status: OnboardingMaterialStatus.PUBLISHED,
          deletedAt: null,
          currentVersionId: { not: null },
          currentVersion: { is: { deletedAt: null } },
        },
        orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
        select: {
          id: true, title: true, category: true, description: true, updatedAt: true,
          currentVersion: { select: { id: true, versionNumber: true, displayName: true, extension: true, mimeType: true, sizeBytes: true, createdAt: true } },
        },
      });
      return NextResponse.json({ ok: true, items: items.map((item) => ({ ...item, downloadUrl: `/api/onboarding-kit/${encodeURIComponent(item.id)}/download` })) });
    } catch (error) {
      return authErrorResponse(error);
    }
  } };
}

export const GET = createOnboardingKitRoute({ db: prisma }).GET;

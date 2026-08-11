import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { createMaterial } from "@/features/onboarding-kit/material-service";
import { materialFormInput, MAX_ONBOARDING_FILE_BYTES, onboardingErrorResponse, toUploadFile } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string; maxBytes: number };

export function createAdminOnboardingKitRoute(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(dependencies.db, request);
        const materials = await dependencies.db.onboardingMaterial.findMany({
          where: { deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
          include: {
            currentVersion: true,
            versions: { where: { deletedAt: null }, orderBy: { versionNumber: "desc" } },
          },
        });
        return NextResponse.json({ ok: true, materials });
      } catch (error) { return onboardingErrorResponse(error); }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(dependencies.db, request);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "请选择要上传的资料文件" }, { status: 400 });
        const material = await createMaterial(actor.id, materialFormInput(form), toUploadFile(file), dependencies);
        return NextResponse.json({ ok: true, material }, { status: 201 });
      } catch (error) { return onboardingErrorResponse(error); }
    },
  };
}

const route = createAdminOnboardingKitRoute({ db: prisma, privateRoot: defaultPrivateRoot, maxBytes: MAX_ONBOARDING_FILE_BYTES });
export const GET = route.GET;
export const POST = route.POST;

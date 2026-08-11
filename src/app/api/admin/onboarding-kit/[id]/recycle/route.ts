import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  permanentlyDeleteMaterial,
  restoreMaterial,
  softDeleteMaterial,
} from "@/features/onboarding-kit/material-recycle-service";
import { MAX_ONBOARDING_FILE_BYTES, onboardingErrorResponse } from "@/features/onboarding-kit/route-utils";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string; maxBytes: number };

function readBody(request: Request) {
  return request.json().catch(() => ({})) as Promise<{ reason?: string; confirmed?: boolean }>;
}

function handleError(error: unknown) {
  return contentRecycleErrorResponse(error) ?? onboardingErrorResponse(error) ?? authErrorResponse(error);
}

export function createAdminMaterialSoftDeleteRoute(dependencies: Dependencies, materialId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      const material = await softDeleteMaterial(actor.id, materialId, dependencies, { reason: body.reason });
      return NextResponse.json({ ok: true, material });
    } catch (error) {
      return handleError(error);
    }
  };
}

export function createAdminMaterialRestoreRoute(dependencies: Dependencies, materialId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const material = await restoreMaterial(actor.id, materialId, dependencies);
      return NextResponse.json({ ok: true, material });
    } catch (error) {
      return handleError(error);
    }
  };
}

export function createAdminMaterialPermanentDeleteRoute(dependencies: Dependencies, materialId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      await permanentlyDeleteMaterial(actor.id, materialId, {
        ...dependencies,
        confirmed: body.confirmed === true,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return handleError(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminMaterialSoftDeleteRoute({
    db: prisma,
    privateRoot: defaultPrivateRoot,
    maxBytes: MAX_ONBOARDING_FILE_BYTES,
  }, id)(request);
}

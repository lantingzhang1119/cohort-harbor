import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  permanentlyDeleteMaterialVersion,
  restoreMaterialVersion,
  softDeleteMaterialVersion,
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

export function createAdminMaterialVersionSoftDeleteRoute(
  dependencies: Dependencies,
  materialId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      const result = await softDeleteMaterialVersion(
        actor.id,
        materialId,
        versionId,
        dependencies,
        { reason: body.reason },
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return handleError(error);
    }
  };
}

export function createAdminMaterialVersionRestoreRoute(
  dependencies: Dependencies,
  materialId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const version = await restoreMaterialVersion(actor.id, materialId, versionId, dependencies);
      return NextResponse.json({ ok: true, version });
    } catch (error) {
      return handleError(error);
    }
  };
}

export function createAdminMaterialVersionPermanentDeleteRoute(
  dependencies: Dependencies,
  materialId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      await permanentlyDeleteMaterialVersion(actor.id, materialId, versionId, {
        ...dependencies,
        confirmed: body.confirmed === true,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return handleError(error);
    }
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  return createAdminMaterialVersionSoftDeleteRoute({
    db: prisma,
    privateRoot: defaultPrivateRoot,
    maxBytes: MAX_ONBOARDING_FILE_BYTES,
  }, id, versionId)(request);
}

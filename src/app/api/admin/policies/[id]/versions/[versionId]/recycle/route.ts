import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  permanentlyDeletePolicyVersion,
  restorePolicyVersion,
  softDeletePolicyVersion,
} from "@/features/policies/policy-recycle-service";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string };

function readBody(request: Request) {
  return request.json().catch(() => ({})) as Promise<{ reason?: string; confirmed?: boolean }>;
}

export function createAdminPolicyVersionSoftDeleteRoute(
  dependencies: Dependencies,
  policyId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      const result = await softDeletePolicyVersion(dependencies.db, {
        actorId: actor.id,
        policyId,
        versionId,
        privateRoot: dependencies.privateRoot,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export function createAdminPolicyVersionRestoreRoute(
  dependencies: Dependencies,
  policyId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const version = await restorePolicyVersion(dependencies.db, {
        actorId: actor.id,
        policyId,
        versionId,
        privateRoot: dependencies.privateRoot,
      });
      return NextResponse.json({ ok: true, version });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export function createAdminPolicyVersionPermanentDeleteRoute(
  dependencies: Dependencies,
  policyId: string,
  versionId: string,
) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      await permanentlyDeletePolicyVersion(dependencies.db, {
        actorId: actor.id,
        policyId,
        versionId,
        privateRoot: dependencies.privateRoot,
        confirmed: body.confirmed === true,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  return createAdminPolicyVersionSoftDeleteRoute(
    { db: prisma, privateRoot: defaultPrivateRoot },
    id,
    versionId,
  )(request);
}

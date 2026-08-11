import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { contentRecycleErrorResponse } from "@/features/content-recycle/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import {
  permanentlyDeletePolicy,
  restorePolicy,
  softDeletePolicy,
} from "@/features/policies/policy-recycle-service";
import { prisma } from "@/lib/db/client";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

type Dependencies = { db: PrismaClient; privateRoot: string };

function readBody(request: Request) {
  return request.json().catch(() => ({})) as Promise<{ reason?: string; confirmed?: boolean }>;
}

export function createAdminPolicySoftDeleteRoute(dependencies: Dependencies, policyId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      const policy = await softDeletePolicy(dependencies.db, {
        actorId: actor.id,
        policyId,
        privateRoot: dependencies.privateRoot,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true, policy });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export function createAdminPolicyRestoreRoute(dependencies: Dependencies, policyId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const policy = await restorePolicy(dependencies.db, {
        actorId: actor.id,
        policyId,
        privateRoot: dependencies.privateRoot,
      });
      return NextResponse.json({ ok: true, policy });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export function createAdminPolicyPermanentDeleteRoute(dependencies: Dependencies, policyId: string) {
  return async function POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(dependencies.db, request);
      const body = await readBody(request);
      await permanentlyDeletePolicy(dependencies.db, {
        actorId: actor.id,
        policyId,
        privateRoot: dependencies.privateRoot,
        confirmed: body.confirmed === true,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return contentRecycleErrorResponse(error) ?? authErrorResponse(error);
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminPolicySoftDeleteRoute({ db: prisma, privateRoot: defaultPrivateRoot }, id)(request);
}

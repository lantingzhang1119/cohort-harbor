import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { generatePolicyPreview } from "@/features/policies/document-preview-service";
import { createPolicyPreviewResponse, findReadyPolicyPreview } from "@/features/policies/policy-preview-response";
import { prisma } from "@/lib/db/client";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const policy = await findReadyPolicyPreview(prisma, id, { publishedOnly: false });
    const version = policy?.versions[0];
    if (!version) return new Response("Not found", { status: 404 });
    return createPolicyPreviewResponse(request, version);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const policy = await prisma.policy.findFirst({
      where: { id, deletedAt: null },
      include: { versions: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const version = policy?.versions[0];
    if (!version) return NextResponse.json({ ok: false, message: "制度版本不存在" }, { status: 404 });
    const updated = await generatePolicyPreview(prisma, version.id);
    return NextResponse.json({ ok: true, version: updated });
  } catch (error) {
    return authErrorResponse(error);
  }
}

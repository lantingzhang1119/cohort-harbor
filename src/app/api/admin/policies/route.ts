import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { PolicyFileError, createPolicy } from "@/features/policies/policy-service";
import { checkPolicyPreviewEnvironment } from "@/features/policies/document-preview-service";
import { prisma } from "@/lib/db/client";

export async function GET(request: Request) {
  try {
    await requireAdminRequest(prisma, request);
    const [policies, previewEnvironment] = await Promise.all([
      prisma.policy.findMany({
        where: { deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
        include: { versions: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } },
      }),
      checkPolicyPreviewEnvironment(),
    ]);
    return NextResponse.json({ ok: true, policies, previewEnvironment });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, message: "请选择制度文件" }, { status: 400 });
    }
    const policy = await createPolicy(prisma, {
      name: String(form.get("name") ?? ""),
      category: String(form.get("category") ?? ""),
      versionNumber: String(form.get("versionNumber") ?? "1.0"),
      effectiveDate: new Date(String(form.get("effectiveDate") ?? "")),
      file: { fileName: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      actorId: actor.id,
    });
    return NextResponse.json({ ok: true, policy }, { status: 201 });
  } catch (error) {
    if (error instanceof PolicyFileError) return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
    return authErrorResponse(error);
  }
}

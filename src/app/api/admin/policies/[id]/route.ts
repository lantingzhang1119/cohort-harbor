import { NextResponse } from "next/server";

import { PolicyStatus } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { PolicyFileError, PolicyStateError, replacePolicyVersion, setPolicySortOrder, setPolicyStatus } from "@/features/policies/policy-service";
import { prisma } from "@/lib/db/client";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const body = (await request.json()) as { status?: string; sortOrder?: number };
    if (body.status !== undefined && !Object.values(PolicyStatus).includes(body.status as PolicyStatus)) {
      return NextResponse.json({ ok: false, message: "制度状态无效" }, { status: 400 });
    }
    if (body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0)) {
      return NextResponse.json({ ok: false, message: "显示顺序必须是大于或等于 0 的整数" }, { status: 400 });
    }
    if (body.status === undefined && body.sortOrder === undefined) {
      return NextResponse.json({ ok: false, message: "没有需要更新的制度字段" }, { status: 400 });
    }
    if (body.status !== undefined) await setPolicyStatus(prisma, id, body.status as PolicyStatus, actor.id);
    if (body.sortOrder !== undefined) await setPolicySortOrder(prisma, id, body.sortOrder, actor.id);
    const policy = await prisma.policy.findUniqueOrThrow({ where: { id } });
    return NextResponse.json({ ok: true, policy });
  } catch (error) {
    if (error instanceof PolicyStateError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { id } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "请选择制度文件" }, { status: 400 });
    const version = await replacePolicyVersion(prisma, id, {
      versionNumber: String(form.get("versionNumber") ?? ""),
      effectiveDate: new Date(String(form.get("effectiveDate") ?? "")),
      file: { fileName: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      actorId: actor.id,
    });
    return NextResponse.json({ ok: true, version }, { status: 201 });
  } catch (error) {
    if (error instanceof PolicyFileError) return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
    return authErrorResponse(error);
  }
}

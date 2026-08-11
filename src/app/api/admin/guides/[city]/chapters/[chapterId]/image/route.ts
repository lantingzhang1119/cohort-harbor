import { NextResponse } from "next/server";

import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { attachGuideChapterImage } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

export async function POST(request: Request, context: { params: Promise<{ city: string; chapterId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { city: text, chapterId } = await context.params;
    if (!Object.values(City).includes(text as City)) return NextResponse.json({ ok: false }, { status: 404 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "请选择图片" }, { status: 400 });
    const kind = form.get("kind") === "MAP" ? "MAP" : "IMAGE";
    const asset = await attachGuideChapterImage(prisma, text as City, chapterId, { fileName: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, kind, actor.id);
    return NextResponse.json({ ok: true, asset });
  } catch (error) { return authErrorResponse(error); }
}

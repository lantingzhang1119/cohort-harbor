import { NextResponse } from "next/server";

import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { deleteGuideChapter, upsertGuideChapter } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

async function params(context: { params: Promise<{ city: string; chapterId: string }> }) {
  const result = await context.params;
  if (!Object.values(City).includes(result.city as City)) throw new Error("城市不存在");
  return { city: result.city as City, chapterId: result.chapterId };
}

export async function PATCH(request: Request, context: { params: Promise<{ city: string; chapterId: string }> }) {
  try { assertSameOrigin(request); const actor = await requireAdminRequest(prisma, request); const value = await params(context); const chapter = await upsertGuideChapter(prisma, value.city, value.chapterId, await request.json(), actor.id); return NextResponse.json({ ok: true, chapter }); } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ city: string; chapterId: string }> }) {
  try { assertSameOrigin(request); const actor = await requireAdminRequest(prisma, request); const value = await params(context); await deleteGuideChapter(prisma, value.city, value.chapterId, actor.id); return NextResponse.json({ ok: true }); } catch (error) { return authErrorResponse(error); }
}

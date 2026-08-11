import { NextResponse } from "next/server";

import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { reorderGuideChapters } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

export async function POST(request: Request, context: { params: Promise<{ city: string }> }) {
  try { assertSameOrigin(request); const actor = await requireAdminRequest(prisma, request); const { city: text } = await context.params; if (!Object.values(City).includes(text as City)) return NextResponse.json({ ok: false }, { status: 404 }); const body = await request.json() as { chapterIds?: string[] }; await reorderGuideChapters(prisma, text as City, body.chapterIds ?? [], actor.id); return NextResponse.json({ ok: true }); } catch (error) { return authErrorResponse(error); }
}

import { NextResponse } from "next/server";

import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { listGuideForAdmin, updateGuide } from "@/features/guides/guide-service";
import { prisma } from "@/lib/db/client";

export async function GET(
  request: Request,
  context: { params: Promise<{ city: string }> },
) {
  try {
    await requireAdminRequest(prisma, request);
    const { city: cityText } = await context.params;
    if (!Object.values(City).includes(cityText as City)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
    return NextResponse.json({ ok: true, guide: await listGuideForAdmin(prisma, cityText as City) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ city: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const { city: cityText } = await context.params;
    if (!Object.values(City).includes(cityText as City)) {
      return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
    }
    const guide = await updateGuide(
      prisma,
      cityText as City,
      (await request.json()) as Parameters<typeof updateGuide>[2],
      actor.id,
    );
    return NextResponse.json({ ok: true, guide });
  } catch (error) {
    return authErrorResponse(error);
  }
}

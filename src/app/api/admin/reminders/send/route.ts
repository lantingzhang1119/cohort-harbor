import { NextResponse } from "next/server";

import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { sendReminder } from "@/features/reminders/reminder-service";
import { prisma } from "@/lib/db/client";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdminRequest(prisma, request);
    const body = await request.json() as { recipientIds: string[]; channels: Array<"IN_APP" | "SIMULATED_EMAIL"> };
    const result = await sendReminder(prisma, { ...body, actorId: actor.id });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return authErrorResponse(error); }
}

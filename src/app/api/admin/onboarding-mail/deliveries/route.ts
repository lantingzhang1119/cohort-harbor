import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { OnboardingMailDeliveryStatus } from "@/generated/prisma/enums";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";

const statusSchema = z.enum([
  OnboardingMailDeliveryStatus.PENDING,
  OnboardingMailDeliveryStatus.SENDING,
  OnboardingMailDeliveryStatus.SENT,
  OnboardingMailDeliveryStatus.FAILED,
  OnboardingMailDeliveryStatus.SKIPPED,
  OnboardingMailDeliveryStatus.CANCELLED,
  OnboardingMailDeliveryStatus.UNKNOWN,
]);
const statusLabels: Record<string, string> = {
  PENDING: "待发送",
  SENDING: "发送中",
  SENT: "已发送",
  FAILED: "发送失败",
  SKIPPED: "已跳过",
  CANCELLED: "已取消",
  UNKNOWN: "发送调用结果未确认（可能已发出）",
};

export function createOnboardingMailDeliveriesRoute({ db }: { db: PrismaClient }) {
  return { async GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      const rawStatus = new URL(request.url).searchParams.get("status");
      const status = rawStatus ? statusSchema.parse(rawStatus) : undefined;
      const rows = await db.onboardingMailDelivery.findMany({
        where: status ? { status } : undefined,
        select: {
          id: true,
          status: true,
          source: true,
          recipientEmailSnapshot: true,
          recipientSnapshot: true,
          scheduledLocalDate: true,
          scheduledAt: true,
          sentAt: true,
          failureCode: true,
          errorSummary: true,
          unknownResolution: true,
          unknownResolvedAt: true,
          resendOfId: true,
          resendDelivery: { select: { id: true } },
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 201,
      });
      return NextResponse.json({
        ok: true,
        deliveries: rows.slice(0, 200).map((row) => ({ ...row, statusLabel: statusLabels[row.status] })),
        truncation: { deliveries: { limit: 200, truncated: rows.length > 200 } },
      });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}
const route = createOnboardingMailDeliveriesRoute({ db: prisma });
export const GET = route.GET;

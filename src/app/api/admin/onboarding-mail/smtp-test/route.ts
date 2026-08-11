import { NextResponse } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { MailAdminError } from "@/features/onboarding-mail/admin-service";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

type Dependencies = { db: PrismaClient; now: () => Date; testConnection: () => Promise<{ ok: true }> };
export function createOnboardingMailSmtpTestRoute(deps: Dependencies) {
  return { async POST(request: Request) {
    try {
      assertSameOrigin(request);
      const actor = await requireAdminRequest(deps.db, request);
      try { await deps.testConnection(); }
      catch {
        await deps.db.auditLog.create({ data: { actorId: actor.id, actorSnapshot: snapshotUserIdentity(actor), action: "ONBOARDING_MAIL_SMTP_TEST", result: "FAILED", createdAt: deps.now() } });
        throw new MailAdminError("SMTP_TEST_FAILED", 502, "SMTP 连接测试失败，请检查服务器配置");
      }
      await deps.db.auditLog.create({ data: { actorId: actor.id, actorSnapshot: snapshotUserIdentity(actor), action: "ONBOARDING_MAIL_SMTP_TEST", result: "SUCCESS", createdAt: deps.now() } });
      return NextResponse.json({ ok: true, testedAt: deps.now() });
    } catch (error) { return onboardingMailErrorResponse(error); }
  } };
}

async function testConfiguredConnection(): Promise<{ ok: true }> {
  const nodemailer = (await import("nodemailer")).default;
  const env = getEnv();
  if (!env.SMTP_HOST || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.SMTP_FROM) {
    throw new Error("SMTP not configured");
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  });
  await transport.verify();
  transport.close();
  return { ok: true };
}
const route = createOnboardingMailSmtpTestRoute({ db: prisma, now: () => new Date(), testConnection: testConfiguredConnection });
export const POST = route.POST;

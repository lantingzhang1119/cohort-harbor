import "dotenv/config";

import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@/generated/prisma/client";
import { createSmtpTransport, type SmtpTransportConfig } from "@/features/mail/smtp-transport";
import type { DeliveryTransport } from "@/features/onboarding-mail/delivery-service";
import { shanghaiDateRange } from "@/features/onboarding-mail/eligibility-service";
import { runOnboardingMailCycle, type WorkerSummary } from "@/features/onboarding-mail/outbox-worker";
import {
  parseOnboardingMailWorkerRuntimeConfig,
  type OnboardingMailWorkerRuntimeConfig,
} from "@/features/onboarding-mail/worker-runtime-config";
import { createPrismaClient } from "@/lib/db/create-client";

export function parseWorkerArgs(args: string[]): { localDate?: string; confirmBulk: boolean } {
  let localDate: string | undefined;
  let confirmBulk = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--date") {
      localDate = args[++index];
      if (!localDate) throw new TypeError("--date 需要 YYYY-MM-DD");
      shanghaiDateRange(localDate);
    } else if (argument === "--confirm-bulk") {
      confirmBulk = true;
    } else {
      throw new TypeError(`未知参数：${argument}`);
    }
  }
  if (confirmBulk && !localDate) {
    throw new TypeError("--confirm-bulk 必须同时指定 --date YYYY-MM-DD");
  }
  return { ...(localDate ? { localDate } : {}), confirmBulk };
}

type WorkerCliDependencies = {
  db?: PrismaClient;
  transport?: DeliveryTransport;
  env?: Partial<NodeJS.ProcessEnv>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  workerId?: string;
  now?: () => Date;
};

export function workerCliDisposition(
  summary: Pick<WorkerSummary, "errors" | "bulkConfirmationRequired" | "acceptedStale" | "unknown" | "failed" | "stale">,
): { exitCode: number; diagnostic: string | null } {
  if (
    summary.errors === 0
    && summary.bulkConfirmationRequired === null
    && summary.acceptedStale === 0
    && summary.unknown === 0
    && summary.failed === 0
    && summary.stale === 0
  ) {
    return { exitCode: 0, diagnostic: null };
  }
  return {
    exitCode: 1,
    diagnostic: `邮件 worker 未完全成功：errors=${summary.errors} bulkConfirmationRequired=${summary.bulkConfirmationRequired ?? 0} acceptedStale=${summary.acceptedStale} unknown=${summary.unknown} failed=${summary.failed} stale=${summary.stale}`,
  };
}

function requiredSmtpEnv(env: Partial<NodeJS.ProcessEnv>, key: "SMTP_HOST" | "SMTP_USERNAME" | "SMTP_PASSWORD" | "SMTP_FROM") {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} 未配置`);
  return value;
}

export function parseProductionSmtpConfig(
  env: Partial<NodeJS.ProcessEnv>,
  config: OnboardingMailWorkerRuntimeConfig,
): SmtpTransportConfig {
  return {
    host: requiredSmtpEnv(env, "SMTP_HOST"),
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    username: requiredSmtpEnv(env, "SMTP_USERNAME"),
    password: requiredSmtpEnv(env, "SMTP_PASSWORD"),
    envelopeSender: requiredSmtpEnv(env, "SMTP_FROM"),
    hardTimeoutMs: config.ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS * 1_000,
  };
}

function productionTransport(
  env: Partial<NodeJS.ProcessEnv>,
  config: OnboardingMailWorkerRuntimeConfig,
): DeliveryTransport {
  return createSmtpTransport(parseProductionSmtpConfig(env, config));
}

export async function runWorkerCli(
  args: string[],
  dependencies: WorkerCliDependencies = {},
): Promise<WorkerSummary> {
  const parsed = parseWorkerArgs(args);
  const env = dependencies.env ?? process.env;
  const config = parseOnboardingMailWorkerRuntimeConfig(env);
  const stderr = dependencies.stderr ?? console.error;
  const runtimeEnabled = config.ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED;
  const transport = dependencies.transport ?? (runtimeEnabled
    ? productionTransport(env, config)
    : { send: async () => { throw new Error("邮件 worker 运行时未启用"); } });
  try {
    const summary = await runOnboardingMailCycle({
      db: dependencies.db,
      transport,
      workerId: dependencies.workerId ?? `${hostname()}-${process.pid}`,
      now: dependencies.now,
      runtimeEnabled,
      localDate: parsed.localDate,
      confirmBulk: parsed.confirmBulk,
      batchSize: config.ONBOARDING_MAIL_WORKER_BATCH_SIZE,
      leaseDurationMs: config.ONBOARDING_MAIL_LEASE_SECONDS * 1_000,
      transportHardTimeoutMs: config.ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS * 1_000,
      safetyMarginMs: config.ONBOARDING_MAIL_LEASE_SAFETY_SECONDS * 1_000,
      retryLimit: config.ONBOARDING_MAIL_RETRY_LIMIT,
      lookbackDays: config.ONBOARDING_MAIL_LOOKBACK_DAYS,
      bulkConfirmThreshold: config.ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD,
      privateRoot: env.PRIVATE_STORAGE_ROOT,
      onError: (diagnostic) => stderr(JSON.stringify(diagnostic)),
    });
    (dependencies.stdout ?? console.log)(JSON.stringify(summary));
    return summary;
  } finally {
    try {
      await transport.close?.();
    } catch {
      // Transport shutdown is best-effort and cannot replace the completed
      // cycle summary or its CLI disposition.
    }
  }
}

type WorkerMainDependencies = Omit<WorkerCliDependencies, "db"> & {
  createDb?: (databaseUrl?: string) => PrismaClient;
};

export async function runWorkerMain(
  args: string[],
  dependencies: WorkerMainDependencies = {},
): Promise<{ summary: WorkerSummary; disposition: ReturnType<typeof workerCliDisposition> }> {
  const env = dependencies.env ?? process.env;
  // Keep all pure invocation/config validation ahead of Prisma construction so
  // a bad unattended-worker configuration cannot touch the database.
  parseWorkerArgs(args);
  const config = parseOnboardingMailWorkerRuntimeConfig(env);
  if (config.ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED) {
    parseProductionSmtpConfig(env, config);
  }
  const db = (dependencies.createDb ?? createPrismaClient)(env.DATABASE_URL);
  const stderr = dependencies.stderr ?? console.error;
  try {
    const summary = await runWorkerCli(args, { ...dependencies, db, env, stderr });
    const disposition = workerCliDisposition(summary);
    if (disposition.diagnostic) stderr(disposition.diagnostic);
    return { summary, disposition };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const { disposition } = await runWorkerMain(process.argv.slice(2));
  if (disposition.exitCode !== 0) process.exitCode = disposition.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "邮件 worker 执行失败");
    process.exitCode = 1;
  });
}

import "server-only";

import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (value === undefined || value === "") return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean());

export const onboardingMailWorkerEnvFields = {
  ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: envBoolean,
  ONBOARDING_MAIL_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  ONBOARDING_MAIL_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(180),
  ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(1_800).default(120),
  ONBOARDING_MAIL_LEASE_SAFETY_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  ONBOARDING_MAIL_RETRY_LIMIT: z.coerce.number().int().min(0).max(10).default(3),
  ONBOARDING_MAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(7).default(1),
  ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(20),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: envBoolean,
};

export function hasValidOnboardingMailWorkerLease(value: {
  ONBOARDING_MAIL_LEASE_SECONDS: number;
  ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS: number;
  ONBOARDING_MAIL_LEASE_SAFETY_SECONDS: number;
}): boolean {
  return value.ONBOARDING_MAIL_LEASE_SECONDS >=
    value.ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS + value.ONBOARDING_MAIL_LEASE_SAFETY_SECONDS;
}

const workerRuntimeConfigSchema = z.object(onboardingMailWorkerEnvFields).superRefine((value, context) => {
  if (!hasValidOnboardingMailWorkerLease(value)) {
    context.addIssue({
      code: "custom",
      path: ["ONBOARDING_MAIL_LEASE_SECONDS"],
      message: "邮件租约时长必须不小于传输超时与安全余量之和",
    });
  }
});

export type OnboardingMailWorkerRuntimeConfig = z.infer<typeof workerRuntimeConfigSchema>;

export function parseOnboardingMailWorkerRuntimeConfig(
  input: Partial<NodeJS.ProcessEnv>,
): OnboardingMailWorkerRuntimeConfig {
  return workerRuntimeConfigSchema.parse(input);
}

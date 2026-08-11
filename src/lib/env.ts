import { createHmac } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  hasValidOnboardingMailWorkerLease,
  onboardingMailWorkerEnvFields,
} from "@/features/onboarding-mail/worker-runtime-config";

const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const onboardingZipTempRoot = z.string().trim().min(1).default("storage/private/tmp/onboarding-zips").refine((value) => {
  const normalized = path.normalize(value);
  const resolved = path.resolve(value);
  return normalized !== "." && normalized !== ".." && resolved !== path.parse(resolved).root;
}, "资料包临时目录不能是文件系统根目录");

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("file:./storage/private/demo.db"),
  ADMIN_USERNAME: z.string().min(3, "管理员账号至少需要 3 个字符"),
  ADMIN_PASSWORD: z.string().min(10, "管理员密码至少需要 10 个字符"),
  AUTH_TOKEN_SECRET: z.string().trim().min(32, "认证令牌密钥至少需要 32 个字符"),
  ADMIN_DISPLAY_NAME: z.string().min(1).default("系统管理员"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  FILE_MAX_PDF_MB: z.coerce.number().positive().default(30),
  FILE_MAX_IMAGE_MB: z.coerce.number().positive().default(10),
  FILE_MAX_EXCEL_MB: z.coerce.number().positive().default(20),
  PRIVATE_STORAGE_ROOT: z.string().min(1).default("storage/private"),
  ONBOARDING_MATERIAL_MAX_MB: z.coerce.number().positive().default(50),
  ONBOARDING_ZIP_MAX_MB: z.coerce.number().positive().default(500),
  ONBOARDING_ZIP_MAX_FILES: z.coerce.number().int().min(1).max(2_000).default(200),
  ONBOARDING_ZIP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(10).default(2),
  ONBOARDING_ZIP_TEMP_ROOT: onboardingZipTempRoot,
  ONBOARDING_MAIL_ATTACHMENT_MAX_MB: z.coerce.number().positive().default(20),
  ONBOARDING_MAIL_MIME_MAX_MB: z.coerce.number().positive().default(25),
  ...onboardingMailWorkerEnvFields,
  ONBOARDING_MAIL_CONFIRMATION_SECRET: z.string().trim().min(32).optional(),
  SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SMTP_HOST: optionalString,
  SMTP_USERNAME: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
}).superRefine((value, context) => {
  if (!hasValidOnboardingMailWorkerLease(value)) {
    context.addIssue({
      code: "custom",
      path: ["ONBOARDING_MAIL_LEASE_SECONDS"],
      message: "邮件租约时长必须不小于传输超时与安全余量之和",
    });
  }
});

type ParsedAppEnv = z.infer<typeof envSchema>;
export type AppEnv = Omit<ParsedAppEnv, "ONBOARDING_MAIL_CONFIRMATION_SECRET"> & {
  ONBOARDING_MAIL_CONFIRMATION_SECRET: string;
};

export function parseEnv(input: Partial<NodeJS.ProcessEnv>): AppEnv {
  const parsed = envSchema.parse(input);
  return {
    ...parsed,
    ONBOARDING_MAIL_CONFIRMATION_SECRET: parsed.ONBOARDING_MAIL_CONFIRMATION_SECRET
      ?? createHmac("sha256", parsed.AUTH_TOKEN_SECRET)
        .update("cohort-harbor:onboarding-mail-confirmation:v1")
        .digest("base64url"),
  };
}

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}

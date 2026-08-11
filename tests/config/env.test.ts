import { describe, expect, it } from "vitest";

import { envSchema, parseEnv } from "@/lib/env";
import { parseOnboardingMailWorkerRuntimeConfig } from "@/features/onboarding-mail/worker-runtime-config";
import { createMailConfirmationToken, verifyMailConfirmationToken } from "@/features/onboarding-mail/admin-service";

describe("parseEnv", () => {
  it("rejects an admin password shorter than ten characters", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "file:./storage/private/demo.db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "short",
        ADMIN_DISPLAY_NAME: "系统管理员",
      }),
    ).toThrow("管理员密码至少需要 10 个字符");
  });

  it("applies safe local defaults", () => {
    const parsed = parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      ADMIN_DISPLAY_NAME: "系统管理员",
    });

    expect(parsed.DATABASE_URL).toBe("file:./storage/private/demo.db");
    expect(parsed.LOGIN_MAX_FAILURES).toBe(5);
    expect(parsed.LOGIN_LOCK_MINUTES).toBe(15);
    expect(parsed.ONBOARDING_MATERIAL_MAX_MB).toBe(50);
    expect(parsed.ONBOARDING_ZIP_MAX_MB).toBe(500);
    expect(parsed.ONBOARDING_ZIP_MAX_FILES).toBe(200);
    expect(parsed.ONBOARDING_ZIP_MAX_CONCURRENT).toBe(2);
    expect(parsed.ONBOARDING_ZIP_TEMP_ROOT).toBe("storage/private/tmp/onboarding-zips");
    expect(parsed.ONBOARDING_MAIL_ATTACHMENT_MAX_MB).toBe(20);
    expect(parsed.ONBOARDING_MAIL_MIME_MAX_MB).toBe(25);
    expect(parsed.ONBOARDING_MAIL_WORKER_BATCH_SIZE).toBe(20);
    expect(parsed.ONBOARDING_MAIL_LOOKBACK_DAYS).toBe(1);
    expect(parsed.ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD).toBe(20);
    expect(parsed.ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED).toBe(false);
    expect(parsed.SQLITE_BUSY_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    ["ONBOARDING_MAIL_LOOKBACK_DAYS", "8"],
    ["ONBOARDING_MATERIAL_MAX_MB", "0"],
    ["ONBOARDING_ZIP_MAX_FILES", "not-a-number"],
    ["ONBOARDING_ZIP_MAX_CONCURRENT", "not-a-number"],
    ["ONBOARDING_MAIL_MIME_MAX_MB", "-1"],
    ["SQLITE_BUSY_TIMEOUT_MS", "99"],
    ["SMTP_PORT", "70000"],
    ["SMTP_PORT", "not-a-port"],
    ["SMTP_SECURE", "sometimes"],
  ])("rejects unsafe %s=%s", (key, value) => {
    expect(() => parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      [key]: value,
    })).toThrow();
  });

  it("rejects a ZIP temporary root that resolves to a filesystem root", () => {
    expect(() => parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      ONBOARDING_ZIP_TEMP_ROOT: "/",
    })).toThrow("资料包临时目录不能是文件系统根目录");
  });

  it("parses complete SMTP configuration without treating false as true", () => {
    const parsed = parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USERNAME: "mailer",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "learning@example.invalid",
      APP_BASE_URL: "http://localhost:3000",
    });
    expect(parsed.SMTP_SECURE).toBe(false);
    expect(parsed.SMTP_PORT).toBe(587);
  });

  it("reuses one worker config shape and keeps both env entrypoints identical at every boundary", async () => {
    const workerConfigModule = await import("@/features/onboarding-mail/worker-runtime-config");
    const sharedFields = (workerConfigModule as typeof workerConfigModule & {
      onboardingMailWorkerEnvFields?: Record<string, unknown>;
    }).onboardingMailWorkerEnvFields;
    expect(sharedFields).toBeDefined();
    for (const [key, fieldSchema] of Object.entries(sharedFields!)) {
      expect((envSchema.shape as Record<string, unknown>)[key]).toBe(fieldSchema);
    }

    const cases: Array<[Partial<NodeJS.ProcessEnv>, boolean]> = [
      [{}, true],
      [{ ONBOARDING_MAIL_WORKER_BATCH_SIZE: "0" }, false],
      [{ ONBOARDING_MAIL_WORKER_BATCH_SIZE: "1" }, true],
      [{ ONBOARDING_MAIL_WORKER_BATCH_SIZE: "100" }, true],
      [{ ONBOARDING_MAIL_WORKER_BATCH_SIZE: "101" }, false],
      [{ ONBOARDING_MAIL_RETRY_LIMIT: "-1" }, false],
      [{ ONBOARDING_MAIL_RETRY_LIMIT: "0" }, true],
      [{ ONBOARDING_MAIL_RETRY_LIMIT: "10" }, true],
      [{ ONBOARDING_MAIL_RETRY_LIMIT: "11" }, false],
      [{ ONBOARDING_MAIL_LOOKBACK_DAYS: "0" }, false],
      [{ ONBOARDING_MAIL_LOOKBACK_DAYS: "1" }, true],
      [{ ONBOARDING_MAIL_LOOKBACK_DAYS: "7" }, true],
      [{ ONBOARDING_MAIL_LOOKBACK_DAYS: "8" }, false],
      [{ SMTP_PORT: "0" }, false],
      [{ SMTP_PORT: "1" }, true],
      [{ SMTP_PORT: "65535" }, true],
      [{ SMTP_PORT: "65536" }, false],
      [{ ONBOARDING_MAIL_LEASE_SECONDS: "30", ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS: "5", ONBOARDING_MAIL_LEASE_SAFETY_SECONDS: "5" }, true],
      [{ ONBOARDING_MAIL_LEASE_SECONDS: "30", ONBOARDING_MAIL_TRANSPORT_TIMEOUT_SECONDS: "26", ONBOARDING_MAIL_LEASE_SAFETY_SECONDS: "5" }, false],
    ];
    for (const [candidate, accepted] of cases) {
      const appAccepted = envSchema.safeParse({
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "change-me-12345",
        ...candidate,
      }).success;
      let workerAccepted = true;
      try {
        parseOnboardingMailWorkerRuntimeConfig(candidate);
      } catch {
        workerAccepted = false;
      }
      expect({ appAccepted, workerAccepted }).toEqual({
        appAccepted: accepted,
        workerAccepted: accepted,
      });
    }
  });

  it("provides a validated stable confirmation secret across server instances", () => {
    const input = {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      ONBOARDING_MAIL_CONFIRMATION_SECRET: "mail-confirmation-secret-for-every-instance-123",
    };
    const first = parseEnv(input);
    const second = parseEnv({ ...input });
    const issued = createMailConfirmationToken({ action: "RESEND", localDate: "2026-07-23", count: 21 }, {
      secret: first.ONBOARDING_MAIL_CONFIRMATION_SECRET,
      now: new Date("2026-07-23T01:00:00.000Z"),
    });

    expect(second.ONBOARDING_MAIL_CONFIRMATION_SECRET).toBe(first.ONBOARDING_MAIL_CONFIRMATION_SECRET);
    expect(() => verifyMailConfirmationToken(issued.token, { action: "RESEND", localDate: "2026-07-23", count: 21 }, {
      secret: second.ONBOARDING_MAIL_CONFIRMATION_SECRET,
      now: new Date("2026-07-23T01:01:00.000Z"),
    })).not.toThrow();
    expect(() => parseEnv({ ...input, ONBOARDING_MAIL_CONFIRMATION_SECRET: "too-short" })).toThrow();
  });
});

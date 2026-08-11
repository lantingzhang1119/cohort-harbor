import path from "node:path";

export function createE2eEnvironment(
  parentEnvironment,
  nextDistDir = ".next-e2e",
  projectRoot = process.cwd(),
) {
  return {
    ...parentEnvironment,
    DATABASE_URL: `file:${path.resolve(projectRoot, "storage/private/e2e.db")}`,
    ADMIN_USERNAME: "e2e-admin",
    ADMIN_PASSWORD: "AdminE2EPass!23",
    AUTH_TOKEN_SECRET: "e2e-only-auth-token-hmac-secret-2026",
    ADMIN_DISPLAY_NAME: "端到端管理员",
    NEXT_DIST_DIR: nextDistDir,
    PRIVATE_STORAGE_ROOT: "storage/private/e2e-assets",
    ONBOARDING_ZIP_TEMP_ROOT: "storage/private/e2e-zips",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "3125",
    SMTP_SECURE: "false",
    SMTP_USERNAME: "e2e-user",
    SMTP_PASSWORD: "e2e-password",
    SMTP_FROM: "onboarding-e2e@example.invalid",
    ONBOARDING_MAIL_CONFIRMATION_SECRET: "e2e-onboarding-confirmation-secret-2026",
    ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false",
    E2E_PRESEEDED: "true",
  };
}

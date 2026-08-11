import { describe, expect, it } from "vitest";

import { createE2eEnvironment } from "../../scripts/e2e-environment.mjs";

describe("E2E child-process environment", () => {
  it("forces mail automation runtime off without depending on the parent process", async () => {
    const parentEnvironment = {
      PATH: "/synthetic/bin",
      DATABASE_URL: "file:./do-not-use.db",
      ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true",
    };
    const environment = createE2eEnvironment(parentEnvironment, ".next-e2e", "/synthetic/project");

    expect(environment).toMatchObject({
      PATH: "/synthetic/bin",
      DATABASE_URL: "file:/synthetic/project/storage/private/e2e.db",
      SMTP_PORT: "3125",
      ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false",
      E2E_PRESEEDED: "true",
    });
    expect(parentEnvironment.ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED).toBe("true");
  });
});

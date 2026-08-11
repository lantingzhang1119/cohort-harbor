import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  globalSetup: process.env.E2E_PRESEEDED === "true" ? undefined : "./e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      testMatch: /(?:admin-desktop|security|portal-editor|onboarding-kit|onboarding-mail)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1440, height: 960 } },
    },
    {
      name: "mobile-chromium",
      testMatch: /employee-mobile\.spec\.ts/,
      use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
});

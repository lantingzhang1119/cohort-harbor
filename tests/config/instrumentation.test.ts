import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const initializeOnboardingZipCleanup = vi.fn(async () => undefined);
const cleanupStalePrivateUploads = vi.fn(async () => ({ scanned: 0, removed: 0 }));
const resolveMailValidationTempRoot = vi.fn((privateRoot: string) => path.join(privateRoot, "tmp/mail-validation"));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ONBOARDING_ZIP_TEMP_ROOT: "storage/private/custom-zips",
    PRIVATE_STORAGE_ROOT: "storage/private/custom-private",
  }),
}));
vi.mock("@/features/onboarding-kit/zip-service", () => ({ initializeOnboardingZipCleanup }));
vi.mock("@/lib/storage/private-upload-validation", () => ({
  cleanupStalePrivateUploads,
  resolveMailValidationTempRoot,
}));

import { register } from "@/instrumentation";

describe("server instrumentation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    initializeOnboardingZipCleanup.mockClear();
    cleanupStalePrivateUploads.mockClear();
    resolveMailValidationTempRoot.mockClear();
  });

  it("resolves the validated ZIP temporary root before startup cleanup", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(initializeOnboardingZipCleanup).toHaveBeenCalledWith({
      zipRoot: path.resolve("storage/private/custom-zips"),
    });
    const privateRoot = path.resolve("storage/private/custom-private");
    expect(resolveMailValidationTempRoot).toHaveBeenCalledWith(privateRoot);
    expect(cleanupStalePrivateUploads).toHaveBeenCalledWith({
      privateRoot,
      tempRoot: path.join(privateRoot, "tmp/mail-validation"),
    });
  });
});

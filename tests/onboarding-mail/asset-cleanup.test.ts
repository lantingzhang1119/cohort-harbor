import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rm(target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
      if (cleanupFailure.enabled && String(target).includes("cohort-harbor-upload-")) {
        throw new Error("simulated staging cleanup failure at /secret/path");
      }
      return actual.rm(target, options);
    },
  };
});

import { OnboardingMailAttachmentRole, Role, UserSource } from "@/generated/prisma/enums";
import { uploadMailAsset } from "@/features/onboarding-mail/asset-service";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { validPng } from "../fixtures/portal-images";
import { createTestDatabase } from "../helpers/test-db";

describe("welcome-mail upload cleanup settlement", () => {
  afterEach(() => { cleanupFailure.enabled = false; });

  it("preserves a committed asset result and returns a path-free warning when staging cleanup fails", async () => {
    const testDb = await createTestDatabase();
    const privateRoot = path.join(path.dirname(testDb.databasePath), "private");
    try {
      const admin = await testDb.db.user.create({ data: {
        employeeNo: "ADMIN-CLEANUP",
        name: "清理管理员",
        email: "cleanup@example.invalid",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: "not-used-in-service-tests",
        workLocation: "SHANGHAI",
      } });
      const bytes = validPng();
      const file: UploadFileLike = {
        fileName: "cleanup.png",
        mimeType: "image/png",
        size: bytes.byteLength,
        stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      };

      const created = await uploadMailAsset(admin.id, file, {
        role: OnboardingMailAttachmentRole.INLINE_BODY,
        contentId: "cleanup-image",
      }, {
        db: testDb.db,
        privateRoot,
        maxBytes: 1024 * 1024,
        hooks: { afterAssetCreate: () => { cleanupFailure.enabled = true; } },
      });

      expect(created.warnings).toEqual(["STAGING_CLEANUP_FAILED"]);
      expect(JSON.stringify(created.warnings)).not.toContain("secret/path");
      await expect(testDb.db.fileAsset.findUnique({ where: { id: created.id } })).resolves.not.toBeNull();
      await expect(testDb.db.auditLog.findFirst({
        where: { action: "ONBOARDING_MAIL_ASSET_UPLOAD", targetId: created.id },
      })).resolves.not.toBeNull();
    } finally {
      cleanupFailure.enabled = false;
      await testDb.cleanup();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AdminIdentityEvent,
  FileAssetKind,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import {
  archiveAdminAccount,
  createAdminAccount,
  listAdminAccounts,
  permanentlyDeleteAdminAccount,
  restoreAdminAccount,
  transferAdminAccount,
} from "@/features/admin-accounts/admin-account-service";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { login } from "@/features/auth/login-service";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import {
  consumePasswordReset,
  hashPasswordResetToken,
  PasswordResetError,
} from "@/features/auth/password-reset-service";
import { createSession, getActiveSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("administrator account lifecycle service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let superAdmin: Awaited<ReturnType<typeof createAdministrator>>;
  let admin: Awaited<ReturnType<typeof createAdministrator>>;

  async function createAdministrator(
    employeeNo: string,
    role: Role,
    password = "InitialPass123",
  ) {
    return testDb.db.user.create({
      data: {
        employeeNo,
        name: employeeNo,
        email: `${employeeNo.toLowerCase()}@example.invalid`,
        role,
        status: UserStatus.ACTIVE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
      },
    });
  }

  beforeEach(async () => {
    testDb = await createTestDatabase();
    superAdmin = await createAdministrator("SUPER-001", Role.SUPER_ADMIN);
    admin = await createAdministrator("ADMIN-001", Role.ADMIN);
  });

  afterEach(async () => testDb.cleanup());

  it("requires the sole active super administrator for every lifecycle operation", async () => {
    const input = {
      employeeNo: "ADMIN-NEW",
      name: "新增管理员",
      email: "new-admin@example.invalid",
    };
    const takeover = {
      ...input,
      temporaryPassword: "NewPass123",
      currentPassword: "InitialPass123",
    };
    const confirmation = {
      currentPassword: "InitialPass123",
      confirmation: "永久删除管理员" as const,
    };

    await expect(listAdminAccounts(testDb.db, admin.id)).rejects.toMatchObject({
      code: "SUPER_ADMIN_REQUIRED",
    });
    await expect(createAdminAccount(testDb.db, input, admin.id)).rejects.toMatchObject({
      code: "SUPER_ADMIN_REQUIRED",
    });
    await expect(
      transferAdminAccount(testDb.db, admin.id, takeover, admin.id),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_REQUIRED" });
    await expect(
      archiveAdminAccount(testDb.db, admin.id, admin.id),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_REQUIRED" });
    await expect(
      restoreAdminAccount(testDb.db, admin.id, admin.id),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_REQUIRED" });
    await expect(
      permanentlyDeleteAdminAccount(testDb.db, admin.id, confirmation, admin.id),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_REQUIRED" });
  });

  it("creates an ordinary administrator with a one-time policy-compliant credential", async () => {
    const result = await createAdminAccount(
      testDb.db,
      {
        employeeNo: " ADMIN-NEW ",
        name: " 新增管理员 ",
        email: "New-Admin@Example.Invalid",
      },
      superAdmin.id,
    );

    expect(result.temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10}$/);
    expect(result.admin).toMatchObject({
      employeeNo: "ADMIN-NEW",
      name: "新增管理员",
      email: "new-admin@example.invalid",
      role: Role.ADMIN,
      mustChangePassword: true,
    });
    expect(result.admin).not.toHaveProperty("passwordHash");
    const stored = await testDb.db.user.findUniqueOrThrow({ where: { id: result.admin.id } });
    await expect(verifyPassword(result.temporaryPassword, stored.passwordHash)).resolves.toBe(true);

    const history = await testDb.db.adminIdentityHistory.findFirstOrThrow({
      where: { subjectAccountId: result.admin.id, event: AdminIdentityEvent.CREATED },
    });
    const audit = await testDb.db.auditLog.findFirstOrThrow({
      where: { targetId: result.admin.id, action: "ADMIN_ACCOUNT_CREATE" },
    });
    expect(JSON.stringify([history, audit])).not.toContain(result.temporaryPassword);
    expect(JSON.stringify([history, audit])).not.toContain("passwordHash");
    expect((await listAdminAccounts(testDb.db, superAdmin.id)).items).toHaveLength(3);
  });

  it("rejects duplicate employee numbers and normalized email addresses transactionally", async () => {
    const historyBefore = await testDb.db.adminIdentityHistory.count();
    await expect(
      createAdminAccount(
        testDb.db,
        { employeeNo: admin.employeeNo, name: "重复", email: "unused@example.invalid" },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_EMPLOYEE_NO" });
    await expect(
      createAdminAccount(
        testDb.db,
        { employeeNo: "ADMIN-OTHER", name: "重复", email: admin.email!.toUpperCase() },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_EMAIL" });
    expect(await testDb.db.adminIdentityHistory.count()).toBe(historyBefore);
    expect(await testDb.db.user.count({ where: { role: Role.ADMIN } })).toBe(1);
  });

  it("transfers an administrator identity, revokes credentials and keeps the account id", async () => {
    await createSession(testDb.db, admin.id);
    await testDb.db.passwordResetToken.create({
      data: {
        tokenHash: "transfer-token",
        userId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
        requestFingerprint: "test",
      },
    });
    const before = snapshotUserIdentity(admin);

    const result = await transferAdminAccount(
      testDb.db,
      admin.id,
      {
        employeeNo: "ADMIN-002",
        name: "接任管理员",
        email: "takeover@example.invalid",
        temporaryPassword: "Takeover123",
        currentPassword: "InitialPass123",
      },
      superAdmin.id,
    );

    expect(result).toMatchObject({ id: admin.id, employeeNo: "ADMIN-002" });
    expect(result).not.toHaveProperty("passwordHash");
    const updated = await testDb.db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(updated.mustChangePassword).toBe(true);
    expect(await testDb.db.session.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);
    expect(await testDb.db.passwordResetToken.count({ where: { userId: admin.id, usedAt: null } })).toBe(0);
    await expect(verifyPassword("Takeover123", updated.passwordHash)).resolves.toBe(true);
    const history = await testDb.db.adminIdentityHistory.findFirstOrThrow({
      where: { subjectAccountId: admin.id, event: AdminIdentityEvent.TRANSFERRED },
    });
    expect(history.beforeSnapshot).toEqual(before);
    expect(history.afterSnapshot).toMatchObject({ name: "接任管理员" });
    expect(JSON.stringify(history)).not.toContain("Takeover123");
  });

  it("allows the super administrator to transfer only its own immutable account", async () => {
    await expect(
      archiveAdminAccount(testDb.db, superAdmin.id, superAdmin.id),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_IMMUTABLE" });
    await expect(
      transferAdminAccount(
        testDb.db,
        superAdmin.id,
        {
          employeeNo: "SUPER-002",
          name: "新超级管理员",
          email: "super-new@example.invalid",
          temporaryPassword: "SuperNew123",
          currentPassword: "InitialPass123",
        },
        superAdmin.id,
      ),
    ).resolves.toMatchObject({ id: superAdmin.id, role: Role.SUPER_ADMIN });
    expect(await testDb.db.user.count({ where: { role: Role.SUPER_ADMIN } })).toBe(1);
  });

  it("rejects wrong reauthentication without changing the target", async () => {
    await expect(
      transferAdminAccount(
        testDb.db,
        admin.id,
        {
          employeeNo: "ADMIN-WRONG",
          name: "不应变更",
          email: "wrong@example.invalid",
          temporaryPassword: "WrongPass123",
          currentPassword: "incorrect",
        },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });
    await expect(
      permanentlyDeleteAdminAccount(
        testDb.db,
        admin.id,
        { currentPassword: "incorrect", confirmation: "永久删除管理员" },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });
    expect(await testDb.db.user.findUnique({ where: { id: admin.id } })).toMatchObject({
      employeeNo: "ADMIN-001",
    });
  });

  it("rejects reusing the subject account's current password during transfer", async () => {
    await expect(
      transferAdminAccount(
        testDb.db,
        admin.id,
        {
          employeeNo: admin.employeeNo,
          name: admin.name,
          email: admin.email!,
          temporaryPassword: "InitialPass123",
          currentPassword: "InitialPass123",
        },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "NEW_PASSWORD_REUSED" });
    await expect(
      transferAdminAccount(
        testDb.db,
        superAdmin.id,
        {
          employeeNo: superAdmin.employeeNo,
          name: superAdmin.name,
          email: superAdmin.email!,
          temporaryPassword: "InitialPass123",
          currentPassword: "InitialPass123",
        },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "NEW_PASSWORD_REUSED" });
  });

  it("archives and restores an ordinary administrator without reviving old sessions", async () => {
    const session = await createSession(testDb.db, admin.id);
    await testDb.db.passwordResetToken.create({
      data: {
        tokenHash: hashPasswordResetToken("archived-admin-token"),
        userId: admin.id,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
        requestFingerprint: "archive-test",
      },
    });
    const archived = await archiveAdminAccount(testDb.db, admin.id, superAdmin.id);
    expect(archived).toMatchObject({
      id: admin.id,
      enabled: false,
      status: UserStatus.DISABLED,
    });
    expect(archived.adminArchivedAt).toBeInstanceOf(Date);
    expect(await testDb.db.session.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: admin.id } })).usedAt).not.toBeNull();

    const restored = await restoreAdminAccount(testDb.db, admin.id, superAdmin.id);
    expect(restored).toMatchObject({ id: admin.id, enabled: true, adminArchivedAt: null });
    expect(await testDb.db.session.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);
    expect(await getActiveSession(testDb.db, session.token)).toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "archived-admin-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("restores a legacy disabled administrator to an operationally active state without reviving sessions", async () => {
    const legacy = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-LEGACY",
        name: "历史停用管理员",
        email: "legacy-admin@example.invalid",
        role: Role.ADMIN,
        status: UserStatus.DISABLED,
        enabled: false,
        adminArchivedAt: null,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("LegacyAdmin123"),
        mustChangePassword: false,
      },
    });
    await createSession(testDb.db, legacy.id);
    await testDb.db.passwordResetToken.create({
      data: {
        tokenHash: hashPasswordResetToken("legacy-admin-token"),
        userId: legacy.id,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
        requestFingerprint: "legacy-restore-test",
      },
    });

    const restored = await restoreAdminAccount(testDb.db, legacy.id, superAdmin.id);

    expect(restored).toMatchObject({
      id: legacy.id,
      enabled: true,
      status: UserStatus.ACTIVE,
      adminArchivedAt: null,
    });
    expect(
      await testDb.db.session.count({ where: { userId: legacy.id, revokedAt: null } }),
    ).toBe(0);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: legacy.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "legacy-admin-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
    await expect(
      login(
        { identifier: legacy.employeeNo, password: "LegacyAdmin123" },
        { db: testDb.db },
      ),
    ).resolves.toMatchObject({ user: { id: legacy.id, role: Role.ADMIN } });
  });

  it("refuses permanent self-deletion and preserves the sole-super invariant", async () => {
    await expect(
      permanentlyDeleteAdminAccount(
        testDb.db,
        superAdmin.id,
        { currentPassword: "InitialPass123", confirmation: "永久删除管理员" },
        superAdmin.id,
      ),
    ).rejects.toMatchObject({ code: "SELF_DELETE_FORBIDDEN" });
    expect(await testDb.db.user.count({ where: { role: Role.SUPER_ADMIN } })).toBe(1);
  });

  it("permanently deletes an ordinary administrator while retaining historical snapshots", async () => {
    const actorSnapshot = snapshotUserIdentity(admin);
    await createSession(testDb.db, admin.id);
    await testDb.db.passwordResetToken.create({
      data: {
        tokenHash: "delete-token",
        userId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
        requestFingerprint: "test",
      },
    });
    const audit = await testDb.db.auditLog.create({
      data: { actorId: admin.id, action: "HISTORICAL_ACTION", result: "SUCCESS" },
    });
    const batch = await testDb.db.rosterImportBatch.create({
      data: {
        sourceName: "history",
        originalFileName: "history.xlsx",
        fileHash: "history-hash",
        actorId: admin.id,
        actorSnapshot,
      },
    });
    const asset = await testDb.db.fileAsset.create({
      data: {
        kind: FileAssetKind.GUIDE_IMAGE,
        storageKey: "history/admin.png",
        originalName: "admin.png",
        mimeType: "image/png",
        sizeBytes: 1,
        sha256: "history-sha",
        uploadedById: admin.id,
        uploadedBySnapshot: actorSnapshot,
      },
    });
    const email = await testDb.db.simulatedEmailLog.create({
      data: {
        recipientId: superAdmin.id,
        recipientSnapshot: snapshotUserIdentity(superAdmin),
        actorId: admin.id,
        templateKey: "HISTORY",
      },
    });
    const receivedEmail = await testDb.db.simulatedEmailLog.create({
      data: {
        recipientId: admin.id,
        recipientSnapshot: actorSnapshot,
        actorId: superAdmin.id,
        actorSnapshot: snapshotUserIdentity(superAdmin),
        templateKey: "HISTORICAL_RECIPIENT",
      },
    });

    await permanentlyDeleteAdminAccount(
      testDb.db,
      admin.id,
      { currentPassword: "InitialPass123", confirmation: "永久删除管理员" },
      superAdmin.id,
    );

    expect(await testDb.db.user.findUnique({ where: { id: admin.id } })).toBeNull();
    expect(await testDb.db.passwordResetToken.count({ where: { userId: admin.id } })).toBe(0);
    expect(await testDb.db.adminIdentityHistory.count({ where: { subjectAccountId: admin.id } })).toBeGreaterThan(0);
    expect(await testDb.db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toMatchObject({
      actorId: null,
      actorSnapshot,
    });
    expect(await testDb.db.rosterImportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({ actorId: null });
    expect(await testDb.db.fileAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ uploadedById: null });
    expect(await testDb.db.simulatedEmailLog.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      actorId: null,
      actorSnapshot,
    });
    expect(await testDb.db.simulatedEmailLog.findUniqueOrThrow({ where: { id: receivedEmail.id } })).toMatchObject({
      recipientId: null,
      recipientSnapshot: actorSnapshot,
    });
  });
});

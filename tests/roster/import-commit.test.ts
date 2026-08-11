import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ConflictResolution,
  Role,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import {
  commitRosterImport,
  RosterCommitError,
  stageRosterImport,
} from "@/features/roster/import-commit-service";
import type { NormalizedRosterRow } from "@/features/roster/types";
import { hashPassword, verifyPassword } from "@/features/auth/password";
import {
  consumePasswordReset,
  hashPasswordResetToken,
  PasswordResetError,
  requestPasswordReset,
} from "@/features/auth/password-reset-service";
import { createPasswordResetSender } from "@/features/auth/password-reset-sender";
import { createSession, getActiveSession } from "@/features/auth/session";
import { updateEmployee } from "@/features/employees/employee-service";
import { createTestDatabase } from "../helpers/test-db";

describe("roster import commit", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    actorId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ADMIN-IMPORT",
          name: "导入管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash: await hashPassword("AdminPassword!23"),
        },
      })
    ).id;
  });
  afterEach(async () => testDb.cleanup());

  function row(
    rowNumber: number,
    employeeNo: string,
    name: string,
    status = "正式",
  ): NormalizedRosterRow {
    return {
      rowNumber,
      employeeNo,
      name,
      email: `${employeeNo.toLowerCase()}@example.invalid`,
      firstDepartment: "导入部门",
      secondDepartment: null,
      position: "导入职位",
      personnelStatus: status,
      hiredAt: new Date("2026-07-01T00:00:00.000Z"),
      leftAt: status === "离职" ? new Date("2026-07-15T00:00:00.000Z") : null,
      workLocation: WorkLocation.UNSET,
      invalidDateFields: [],
    };
  }

  async function stage(rows: NormalizedRosterRow[]) {
    return stageRosterImport(testDb.db, {
      rows,
      metadata: {
        sourceName: "ExcelRosterSource",
        originalFileName: "fictional.xlsx",
        fileHash: `hash-${Math.random()}`,
      },
      actorId,
    });
  }

  function runBeforeNextTransaction(action: () => Promise<void>): PrismaClient {
    let intercepted = false;
    return new Proxy(testDb.db, {
      get(target, property) {
        if (property === "$transaction") {
          return async function interceptedTransaction<T>(
            operation: (transaction: Prisma.TransactionClient) => Promise<T>,
          ): Promise<T> {
            if (!intercepted) {
              intercepted = true;
              await action();
            }
            return target.$transaction(operation);
          };
        }
        return Reflect.get(target, property, target);
      },
    }) as PrismaClient;
  }

  it("upserts idempotently, preserves manual passwords/history and disables departures", async () => {
    await testDb.db.exam.create({ data: { name: "导入自动任务", dueDaysAfterHire: 7, enabled: true } });
    const manualHash = await hashPassword("ManualPass!456");
    const manual = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-601",
        name: "手工账号旧名",
        email: "test-601@example.invalid",
        sourceType: UserSource.MANUAL,
        passwordHash: manualHash,
        workLocation: WorkLocation.XIAN,
      },
    });
    const rows = [
      row(2, "TEST-601", "手工账号新名"),
      row(3, "TEST-602", "新员工"),
      row(4, "TEST-603", "离职员工", "离职"),
    ];

    const first = await stage(rows);
    const result = await commitRosterImport(testDb.db, {
      batchId: first.batchId,
      decisions: [],
      actorId,
    });
    expect(result).toMatchObject({ createdCount: 2, updatedCount: 1 });

    const preserved = await testDb.db.user.findUniqueOrThrow({
      where: { employeeNo: "TEST-601" },
    });
    expect(preserved.id).toBe(manual.id);
    expect(preserved.sourceType).toBe(UserSource.MANUAL);
    expect(preserved.workLocation).toBe(WorkLocation.XIAN);
    await expect(verifyPassword("ManualPass!456", preserved.passwordHash)).resolves.toBe(true);
    const departed = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "TEST-603" } });
    expect(departed).toMatchObject({ status: UserStatus.DEPARTED, enabled: false });
    const imported = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "TEST-602" } });
    await expect(verifyPassword("DemoEmployeePass2026", imported.passwordHash)).resolves.toBe(true);
    expect(await testDb.db.examAssignment.count()).toBe(2);
    expect(await testDb.db.examAssignment.count({ where: { userId: departed.id } })).toBe(0);

    const second = await stage(rows);
    const repeated = await commitRosterImport(testDb.db, {
      batchId: second.batchId,
      decisions: [],
      actorId,
    });
    expect(repeated.createdCount).toBe(0);
    expect(await testDb.db.user.count({ where: { employeeNo: { startsWith: "TEST-60" } } })).toBe(3);
  });

  it("preserves missing manual accounts but disables missing Excel accounts", async () => {
    const passwordHash = await hashPassword("InitialPass!23");
    const manual = await testDb.db.user.create({ data: { employeeNo: "MANUAL-MISSING", name: "手工保留", email: "manual-missing@example.invalid", sourceType: UserSource.MANUAL, passwordHash } });
    const imported = await testDb.db.user.create({ data: { employeeNo: "EXCEL-MISSING", name: "导入缺失", email: "excel-missing@example.invalid", sourceType: UserSource.EXCEL, passwordHash } });

    const batch = await stage([row(2, "TEST-610", "当前员工")]);
    await commitRosterImport(testDb.db, { batchId: batch.batchId, decisions: [], actorId });

    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: manual.id } })).enabled).toBe(true);
    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: imported.id } })).enabled).toBe(false);
  });

  it("revokes sessions and invalidates reset tokens when an existing employee is marked departed in the file", async () => {
    const passwordHash = await hashPassword("LifecyclePass123");
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-611",
        name: "文件内离职员工",
        email: "test-611@example.invalid",
        sourceType: UserSource.EXCEL,
        passwordHash,
      },
    });
    const session = await createSession(testDb.db, employee.id);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("departed-in-file-token"),
        requestFingerprint: "1".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    const departedBatch = await stage([row(2, employee.employeeNo, employee.name, "离职")]);
    await commitRosterImport(testDb.db, { batchId: departedBatch.batchId, decisions: [], actorId });

    expect((await testDb.db.session.findUniqueOrThrow({ where: { id: session.sessionId } })).revokedAt).not.toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();

    const restoredBatch = await stage([row(2, employee.employeeNo, employee.name)]);
    await commitRosterImport(testDb.db, {
      batchId: restoredBatch.batchId,
      decisions: restoredBatch.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        resolution: ConflictResolution.KEEP_PASSWORD,
      })),
      actorId,
    });

    expect(await getActiveSession(testDb.db, session.token)).toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "departed-in-file-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
    await expect(verifyPassword("LifecyclePass123", (await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } })).passwordHash)).resolves.toBe(true);
  });

  it("revokes sessions and invalidates reset tokens when an imported employee is missing from the next file", async () => {
    const passwordHash = await hashPassword("MissingPass123");
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-612",
        name: "文件缺失离职员工",
        email: "test-612@example.invalid",
        sourceType: UserSource.EXCEL,
        passwordHash,
      },
    });
    const session = await createSession(testDb.db, employee.id);
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("missing-from-file-token"),
        requestFingerprint: "2".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });

    const departedBatch = await stage([row(2, "TEST-613", "当前员工")]);
    await commitRosterImport(testDb.db, { batchId: departedBatch.batchId, decisions: [], actorId });

    expect((await testDb.db.session.findUniqueOrThrow({ where: { id: session.sessionId } })).revokedAt).not.toBeNull();
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();

    const restoredBatch = await stage([
      row(2, employee.employeeNo, employee.name),
      row(3, "TEST-613", "当前员工"),
    ]);
    await commitRosterImport(testDb.db, {
      batchId: restoredBatch.batchId,
      decisions: restoredBatch.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        resolution: ConflictResolution.KEEP_PASSWORD,
      })),
      actorId,
    });

    expect(await getActiveSession(testDb.db, session.token)).toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "missing-from-file-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
    await expect(verifyPassword("MissingPass123", (await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } })).passwordHash)).resolves.toBe(true);
  });

  it("invalidates previously issued reset tokens when an existing employee email changes", async () => {
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-614",
        name: "邮箱变更员工",
        email: "test-614-old@example.invalid",
        sourceType: UserSource.EXCEL,
        passwordHash: await hashPassword("RosterEmailPass123"),
      },
    });
    await testDb.db.passwordResetToken.create({
      data: {
        userId: employee.id,
        tokenHash: hashPasswordResetToken("roster-email-token"),
        requestFingerprint: "5".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });
    const updatedRow = row(2, employee.employeeNo, employee.name);
    updatedRow.email = "test-614-new@example.invalid";

    const batch = await stage([updatedRow]);
    await commitRosterImport(testDb.db, { batchId: batch.batchId, decisions: [], actorId });

    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } })).email).toBe("test-614-new@example.invalid");
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db },
        { token: "roster-email-token", newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("uses the transaction-current email when invalidating a reset token issued during roster commit", async () => {
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-615",
        name: "并发邮箱员工",
        email: "test-615@example.invalid",
        sourceType: UserSource.EXCEL,
        passwordHash: await hashPassword("RosterRacePass123"),
      },
    });
    const stagedRow = row(2, employee.employeeNo, employee.name);
    const batch = await stage([stagedRow]);
    const now = new Date("2026-07-23T08:00:00.000Z");
    let issuedToken = "";
    const concurrentDb = runBeforeNextTransaction(async () => {
      await updateEmployee(
        testDb.db,
        employee.id,
        { email: "test-615-new@example.invalid" },
        actorId,
      );
      const issued = await requestPasswordReset(
        {
          db: testDb.db,
          sender: createPasswordResetSender({
            db: testDb.db,
            env: {
              NODE_ENV: "development",
              APP_BASE_URL: "http://localhost:3000",
            },
          }),
          now: () => now,
          randomBytes: (size) => Buffer.alloc(size, 0x71),
        },
        {
          identifier: "test-615-new@example.invalid",
          requestSource: "203.0.113.115",
        },
      );
      issuedToken = new URL(issued.developmentPreview!.url).searchParams.get("token")!;
    });

    await commitRosterImport(concurrentDb, {
      batchId: batch.batchId,
      decisions: [],
      actorId,
    });

    expect((await testDb.db.user.findUniqueOrThrow({ where: { id: employee.id } })).email).toBe("test-615@example.invalid");
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: employee.id } })).usedAt).not.toBeNull();
    await expect(
      consumePasswordReset(
        { db: testDb.db, now: () => now },
        { token: issuedToken, newPassword: "ReplacementPass456" }, // gitleaks:allow -- deterministic synthetic fixture
      ),
    ).rejects.toMatchObject({ code: "USED" } satisfies Partial<PasswordResetError>);
  });

  it("makes no employee changes while a blocking conflict is unresolved", async () => {
    const batch = await stage([
      row(2, "TEST-620", "重复甲"),
      row(3, "TEST-620", "重复乙"),
    ]);
    await expect(
      commitRosterImport(testDb.db, { batchId: batch.batchId, decisions: [], actorId }),
    ).rejects.toBeInstanceOf(RosterCommitError);
    expect(await testDb.db.user.count({ where: { employeeNo: "TEST-620" } })).toBe(0);

    const committed = await commitRosterImport(testDb.db, {
      batchId: batch.batchId,
      decisions: batch.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        resolution: ConflictResolution.KEEP_LAST,
      })),
      actorId,
    });
    expect(committed.createdCount).toBe(1);
    expect((await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "TEST-620" } })).name).toBe("重复乙");
  });

  it("requires explicit confirmation for a rehire and supports password reset", async () => {
    const oldHash = await hashPassword("OldDeparted!23");
    const departed = await testDb.db.user.create({
      data: {
        employeeNo: "TEST-630",
        name: "返聘员工",
        email: "test-630@example.invalid",
        sourceType: UserSource.EXCEL,
        status: UserStatus.DEPARTED,
        enabled: false,
        passwordHash: oldHash,
      },
    });
    await testDb.db.passwordResetToken.create({
      data: {
        userId: departed.id,
        tokenHash: hashPasswordResetToken("rehire-reset-token"),
        requestFingerprint: "6".repeat(64),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-23T00:00:00.000Z"),
      },
    });
    const batch = await stage([row(2, "TEST-630", "返聘员工")]);
    expect(batch.conflicts[0]?.type).toBe("REHIRE_CONFIRMATION");
    await commitRosterImport(testDb.db, {
      batchId: batch.batchId,
      decisions: [
        { conflictId: batch.conflicts[0]!.id, resolution: ConflictResolution.RESET_PASSWORD },
      ],
      actorId,
    });
    const rehired = await testDb.db.user.findUniqueOrThrow({ where: { employeeNo: "TEST-630" } });
    expect(rehired).toMatchObject({ status: UserStatus.ACTIVE, enabled: true, mustChangePassword: true });
    await expect(verifyPassword("DemoEmployeePass2026", rehired.passwordHash)).resolves.toBe(true);
    expect((await testDb.db.passwordResetToken.findFirstOrThrow({ where: { userId: departed.id } })).usedAt).not.toBeNull();
  });
});

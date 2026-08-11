import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ConflictResolution,
  ConflictType,
  ImportBatchStatus,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { hashPassword } from "@/features/auth/password";
import { rescheduleAutomaticWelcomeMailForUsers } from "@/features/onboarding-mail/scheduler";
import { previewRosterImport } from "@/features/roster/import-preview-service";
import type {
  NormalizedRosterRow,
  RosterBatchMetadata,
} from "@/features/roster/types";

type SerializedRow = Omit<NormalizedRosterRow, "hiredAt" | "leftAt"> & {
  hiredAt: string | null;
  leftAt: string | null;
};

type PreviewPayload = {
  rows: SerializedRow[];
  issues: ReturnType<typeof previewRosterImport>["issues"];
  summary: ReturnType<typeof previewRosterImport>["summary"];
};

export class RosterCommitError extends Error {
  constructor(
    public readonly code:
      | "BATCH_NOT_FOUND"
      | "UNRESOLVED_CONFLICT"
      | "MANUAL_REIMPORT_REQUIRED"
      | "INVALID_RESOLUTION",
    message: string,
  ) {
    super(message);
    this.name = "RosterCommitError";
  }
}

function serializeRow(row: NormalizedRosterRow): SerializedRow {
  return {
    ...row,
    hiredAt: row.hiredAt?.toISOString() ?? null,
    leftAt: row.leftAt?.toISOString() ?? null,
  };
}

function deserializeRow(row: SerializedRow): NormalizedRosterRow {
  return {
    ...row,
    hiredAt: row.hiredAt ? new Date(row.hiredAt) : null,
    leftAt: row.leftAt ? new Date(row.leftAt) : null,
  };
}

export async function stageRosterImport(
  db: PrismaClient,
  input: {
    rows: NormalizedRosterRow[];
    metadata: RosterBatchMetadata;
    actorId: string;
  },
) {
  const employeeNos = input.rows.map((row) => row.employeeNo).filter(Boolean);
  const existing = await db.user.findMany({
    where: { employeeNo: { in: employeeNos }, role: Role.EMPLOYEE },
    select: { employeeNo: true, status: true },
  });
  const departedEmployeeNos = new Set(
    existing
      .filter((user) => user.status === UserStatus.DEPARTED)
      .map((user) => user.employeeNo),
  );
  const preview = previewRosterImport(input.rows, { departedEmployeeNos });
  const conflicts: Array<{
    rowNumber: number;
    type: ConflictType;
    rowPayload: Prisma.InputJsonValue;
  }> = preview.conflicts.map((conflict) => ({
    rowNumber: conflict.rowNumbers[0] ?? 0,
    type:
      conflict.type === "DUPLICATE_EMPLOYEE_NO"
        ? ConflictType.DUPLICATE_EMPLOYEE_NO
        : ConflictType.DUPLICATE_EMAIL,
    rowPayload: {
      key: conflict.key,
      rowNumbers: conflict.rowNumbers,
    },
  }));
  const invalidRows = new Map<number, string[]>();
  for (const issue of preview.issues.filter((item) => item.blocking)) {
    invalidRows.set(issue.rowNumber, [
      ...(invalidRows.get(issue.rowNumber) ?? []),
      issue.code,
    ]);
  }
  for (const [rowNumber, codes] of invalidRows) {
    conflicts.push({
      rowNumber,
      type: ConflictType.INVALID_ROW,
      rowPayload: { rowNumbers: [rowNumber], codes },
    });
  }
  for (const row of input.rows) {
    if (
      departedEmployeeNos.has(row.employeeNo) &&
      row.personnelStatus !== "离职"
    ) {
      conflicts.push({
        rowNumber: row.rowNumber,
        type: ConflictType.REHIRE_CONFIRMATION,
        rowPayload: { key: row.employeeNo, rowNumbers: [row.rowNumber] },
      });
    }
  }

  const payload: PreviewPayload = {
    rows: input.rows.map(serializeRow),
    issues: preview.issues,
    summary: preview.summary,
  };
  const actor = await db.user.findUniqueOrThrow({
    where: { id: input.actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  const batch = await db.rosterImportBatch.create({
    data: {
      sourceName: input.metadata.sourceName,
      originalFileName: input.metadata.originalFileName,
      fileHash: input.metadata.fileHash,
      status: conflicts.length ? ImportBatchStatus.PREVIEW : ImportBatchStatus.READY,
      totalRows: input.rows.length,
      conflictCount: conflicts.length,
      errorCount: preview.summary.errorRows,
      previewPayload: payload as unknown as Prisma.InputJsonValue,
      actorId: input.actorId,
      actorSnapshot: snapshotUserIdentity(actor),
      conflicts: { create: conflicts },
    },
    include: { conflicts: true },
  });
  return {
    batchId: batch.id,
    summary: preview.summary,
    issues: preview.issues,
    conflicts: batch.conflicts,
  };
}

type Decision = { conflictId: string; resolution: ConflictResolution };

function payloadData(value: Prisma.JsonValue): {
  key?: string;
  rowNumbers: number[];
} {
  const data = value as { key?: unknown; rowNumbers?: unknown };
  return {
    key: typeof data.key === "string" ? data.key : undefined,
    rowNumbers: Array.isArray(data.rowNumbers)
      ? data.rowNumbers.filter((item): item is number => typeof item === "number")
      : [],
  };
}

export async function commitRosterImport(
  db: PrismaClient,
  input: {
    batchId: string;
    decisions: Decision[];
    actorId: string;
    temporaryPassword?: string;
  },
) {
  const batch = await db.rosterImportBatch.findUnique({
    where: { id: input.batchId },
    include: { conflicts: true },
  });
  if (!batch) throw new RosterCommitError("BATCH_NOT_FOUND", "导入批次不存在");
  if (batch.status === ImportBatchStatus.COMMITTED) {
    return {
      createdCount: batch.createdCount,
      updatedCount: batch.updatedCount,
      disabledCount: batch.disabledCount,
      restoredCount: batch.restoredCount,
      skippedCount: batch.skippedCount,
    };
  }
  const payload = batch.previewPayload as unknown as PreviewPayload;
  const rows = payload.rows.map(deserializeRow);
  const decisions = new Map(input.decisions.map((decision) => [decision.conflictId, decision.resolution]));
  const removedRows = new Set<number>();
  const rehireDecisions = new Map<string, ConflictResolution>();

  for (const conflict of batch.conflicts) {
    const resolution = decisions.get(conflict.id);
    if (!resolution) {
      throw new RosterCommitError("UNRESOLVED_CONFLICT", "仍有冲突尚未处理");
    }
    if (resolution === ConflictResolution.MANUAL_REIMPORT) {
      throw new RosterCommitError("MANUAL_REIMPORT_REQUIRED", "请修正 Excel 后重新预检");
    }
    const data = payloadData(conflict.rowPayload);
    if (conflict.type === ConflictType.REHIRE_CONFIRMATION) {
      if (
        resolution !== ConflictResolution.KEEP_PASSWORD &&
        resolution !== ConflictResolution.RESET_PASSWORD
      ) {
        throw new RosterCommitError("INVALID_RESOLUTION", "返聘确认选项无效");
      }
      if (data.key) rehireDecisions.set(data.key, resolution);
      continue;
    }
    if (conflict.type === ConflictType.INVALID_ROW) {
      if (resolution !== ConflictResolution.SKIP) {
        throw new RosterCommitError("INVALID_RESOLUTION", "无效行只能跳过或重新导入");
      }
      data.rowNumbers.forEach((rowNumber) => removedRows.add(rowNumber));
      continue;
    }
    if (resolution === ConflictResolution.SKIP) {
      data.rowNumbers.forEach((rowNumber) => removedRows.add(rowNumber));
    } else if (resolution === ConflictResolution.KEEP_FIRST) {
      data.rowNumbers.slice(1).forEach((rowNumber) => removedRows.add(rowNumber));
    } else if (resolution === ConflictResolution.KEEP_LAST) {
      data.rowNumbers.slice(0, -1).forEach((rowNumber) => removedRows.add(rowNumber));
    } else {
      throw new RosterCommitError("INVALID_RESOLUTION", "重复项处理选项无效");
    }
  }

  const selectedRows = rows.filter((row) => !removedRows.has(row.rowNumber));
  const employeeNos = selectedRows.map((row) => row.employeeNo);
  const existingUsers = await db.user.findMany({
    where: { employeeNo: { in: employeeNos }, role: Role.EMPLOYEE },
  });
  const existingByNumber = new Map(existingUsers.map((user) => [user.employeeNo, user]));
  const passwordHashes = new Map<string, string>();
  const temporaryPassword = input.temporaryPassword ?? "DemoEmployeePass2026";
  for (const row of selectedRows) {
    if (
      !existingByNumber.has(row.employeeNo) ||
      rehireDecisions.get(row.employeeNo) === ConflictResolution.RESET_PASSWORD
    ) {
      passwordHashes.set(row.employeeNo, await hashPassword(temporaryPassword));
    }
  }

  const { missingImportedUserIds, ...result } = await db.$transaction(
    async (transaction) => {
      let createdCount = 0;
      let updatedCount = 0;
      let restoredCount = 0;
      let departedInFile = 0;
      const deactivatedUserIds = new Set<string>();
      const resetInvalidatedUserIds = new Set<string>();
      const lifecycleChangedAt = new Date();
      const currentExistingByNumber = new Map<string, (typeof existingUsers)[number]>();
      for (const snapshot of existingUsers) {
        await transaction.$executeRaw`
          UPDATE "User"
          SET "id" = "id"
          WHERE "id" = ${snapshot.id} AND "role" = ${Role.EMPLOYEE}
        `;
        const current = await transaction.user.findFirst({
          where: { id: snapshot.id, role: Role.EMPLOYEE },
        });
        if (!current || current.employeeNo !== snapshot.employeeNo) {
          throw new RosterCommitError(
            "MANUAL_REIMPORT_REQUIRED",
            "员工身份在导入期间已变更，请重新预检后导入",
          );
        }
        currentExistingByNumber.set(current.employeeNo, current);
      }
      const exam = await transaction.exam.findFirst({
        where: { enabled: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, dueDaysAfterHire: true },
      });
      for (const row of selectedRows) {
        const existing = currentExistingByNumber.get(row.employeeNo);
        const departed = row.personnelStatus === "离职";
        const commonData = {
          name: row.name,
          email: row.email,
          firstDepartment: row.firstDepartment,
          secondDepartment: row.secondDepartment,
          position: row.position,
          hiredAt: row.hiredAt,
          leftAt: row.leftAt,
          status: departed ? UserStatus.DEPARTED : UserStatus.ACTIVE,
          enabled: !departed,
        };
        if (departed) departedInFile += 1;
        if (existing) {
          if (!departed && (!existing.enabled || existing.status === UserStatus.DEPARTED)) {
            restoredCount += 1;
          }
          const resetHash = passwordHashes.get(row.employeeNo);
          await transaction.user.update({
            where: { id: existing.id },
            data: {
              ...commonData,
              ...(resetHash
                ? {
                    passwordHash: resetHash,
                    mustChangePassword: true,
                    failedLoginCount: 0,
                    lockedUntil: null,
                  }
              : {}),
            },
          });
          if (departed) {
            deactivatedUserIds.add(existing.id);
            resetInvalidatedUserIds.add(existing.id);
          }
          if (row.email !== existing.email) resetInvalidatedUserIds.add(existing.id);
          if (resetHash) resetInvalidatedUserIds.add(existing.id);
          updatedCount += 1;
        } else {
          await transaction.user.create({
            data: {
              employeeNo: row.employeeNo,
              ...commonData,
              passwordHash: passwordHashes.get(row.employeeNo)!,
              mustChangePassword: true,
              role: Role.EMPLOYEE,
              sourceType: UserSource.EXCEL,
            },
          });
          createdCount += 1;
        }
        if (!departed && exam) {
          const user = await transaction.user.findUniqueOrThrow({
            where: { employeeNo: row.employeeNo },
            select: { id: true, hiredAt: true },
          });
          const basis = user.hiredAt ?? new Date();
          await transaction.examAssignment.upsert({
            where: { userId_examId: { userId: user.id, examId: exam.id } },
            create: {
              userId: user.id,
              examId: exam.id,
              dueAt: new Date(basis.getTime() + exam.dueDaysAfterHire * 86_400_000),
            },
            update: {},
          });
        }
      }

      const missingImportedUsers = await transaction.user.findMany({
        where: {
          role: Role.EMPLOYEE,
          sourceType: UserSource.EXCEL,
          enabled: true,
          employeeNo: { notIn: employeeNos },
        },
        select: { id: true },
      });
      const missingImportedUserIds = missingImportedUsers.map((user) => user.id);
      const missingImported = missingImportedUserIds.length
        ? await transaction.user.updateMany({
            where: {
              id: { in: missingImportedUserIds },
              enabled: true,
            },
            data: { enabled: false, status: UserStatus.DEPARTED },
          })
        : { count: 0 };
      missingImportedUserIds.forEach((userId) => {
        deactivatedUserIds.add(userId);
        resetInvalidatedUserIds.add(userId);
      });

      const lifecycleUserIds = [...deactivatedUserIds];
      if (lifecycleUserIds.length) {
        await transaction.session.updateMany({
          where: { userId: { in: lifecycleUserIds }, revokedAt: null },
          data: { revokedAt: lifecycleChangedAt },
        });
      }
      const resetInvalidationIds = [...resetInvalidatedUserIds];
      if (resetInvalidationIds.length) {
        await transaction.passwordResetToken.updateMany({
          where: { userId: { in: resetInvalidationIds }, usedAt: null },
          data: { usedAt: lifecycleChangedAt },
        });
      }
      const disabledCount = missingImported.count + departedInFile;
      for (const conflict of batch.conflicts) {
        await transaction.rosterConflict.update({
          where: { id: conflict.id },
          data: {
            resolution: decisions.get(conflict.id),
            resolvedAt: new Date(),
          },
        });
      }
      const skippedCount = removedRows.size;
      await transaction.rosterImportBatch.update({
        where: { id: batch.id },
        data: {
          status: ImportBatchStatus.COMMITTED,
          createdCount,
          updatedCount,
          disabledCount,
          restoredCount,
          skippedCount,
          committedAt: new Date(),
        },
      });
      await writeAuditLog(transaction, {
        actorId: input.actorId,
        action: "ROSTER_IMPORT_COMMIT",
        targetType: "ROSTER_IMPORT_BATCH",
        targetId: batch.id,
        result: "SUCCESS",
        metadata: {
          totalRows: rows.length,
          createdCount,
          updatedCount,
          disabledCount,
          restoredCount,
          skippedCount,
        },
      });
      return {
        createdCount,
        updatedCount,
        disabledCount,
        restoredCount,
        skippedCount,
        missingImportedUserIds,
      };
    },
    { timeout: 60_000 },
  );
  const affected = await db.user.findMany({
    where: { employeeNo: { in: employeeNos }, role: Role.EMPLOYEE },
    select: { id: true },
  });
  await rescheduleAutomaticWelcomeMailForUsers(db, [
    ...affected.map((user) => user.id),
    ...missingImportedUserIds,
  ]);
  return result;
}

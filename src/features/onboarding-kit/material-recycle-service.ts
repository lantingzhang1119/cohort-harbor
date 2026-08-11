import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { OnboardingMaterialStatus, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import {
  RECYCLE_RETENTION_MS,
  type PublishOutcome,
} from "@/features/content-recycle/constants";
import { ContentRecycleError } from "@/features/content-recycle/errors";
import { unlinkPrivateStorageKeys } from "@/features/content-recycle/storage-cleanup";

type MaterialDb = PrismaClient;
type Tx = Prisma.TransactionClient;
type MaterialOptions = { db: MaterialDb; privateRoot: string; maxBytes: number };

async function authorizedActor(db: Pick<PrismaClient, "user"> | Tx, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN) {
    throw new AuthError("FORBIDDEN", 403);
  }
  return { actor, snapshot: snapshotUserIdentity(actor) };
}

const materialInclude = {
  currentVersion: true,
  versions: { orderBy: { versionNumber: "desc" as const } },
};

async function loadActiveMaterial(transaction: Tx, materialId: string) {
  const material = await transaction.onboardingMaterial.findFirst({
    where: { id: materialId, deletedAt: null },
    include: {
      versions: {
        where: { deletedAt: null },
        orderBy: { versionNumber: "desc" },
      },
    },
  });
  if (!material) throw new ContentRecycleError("NOT_FOUND", "资料不存在或已进入回收站");
  return material;
}

export async function softDeleteMaterialVersion(
  actorId: string,
  materialId: string,
  versionId: string,
  options: MaterialOptions,
  input: { reason?: string } = {},
) {
  await authorizedActor(options.db, actorId);
  return options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const material = await loadActiveMaterial(transaction, materialId);
    const version = material.versions.find((item) => item.id === versionId)
      ?? await transaction.onboardingMaterialVersion.findFirst({
        where: { id: versionId, materialId },
      });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "资料版本不存在");
    if (version.deletedAt) throw new ContentRecycleError("ALREADY_DELETED", "资料版本已在回收站中");

    const isCurrent = material.currentVersionId === version.id;
    const remaining = material.versions.filter((item) => item.id !== version.id);
    let publishOutcome: PublishOutcome = "UNCHANGED";
    let rolledBackToVersionNumber: number | undefined;
    let nextStatus: OnboardingMaterialStatus | undefined;
    let nextCurrentVersionId: string | null | undefined;

    if (isCurrent) {
      if (remaining[0]) {
        publishOutcome = material.status === OnboardingMaterialStatus.PUBLISHED ? "ROLLED_BACK" : "UNCHANGED";
        rolledBackToVersionNumber = remaining[0].versionNumber;
        nextCurrentVersionId = remaining[0].id;
      } else {
        nextCurrentVersionId = null;
        if (material.status === OnboardingMaterialStatus.PUBLISHED) {
          publishOutcome = "UNPUBLISHED";
          nextStatus = OnboardingMaterialStatus.ARCHIVED;
        } else {
          publishOutcome = "UNCHANGED";
        }
      }
    }

    const deletedAt = new Date();
    await transaction.onboardingMaterialVersion.update({
      where: { id: version.id },
      data: {
        deletedAt,
        deletedById: actorId,
        deletedBySnapshot: snapshot,
      },
    });

    if (nextCurrentVersionId !== undefined || nextStatus) {
      await transaction.onboardingMaterial.update({
        where: { id: material.id },
        data: {
          ...(nextCurrentVersionId !== undefined ? { currentVersionId: nextCurrentVersionId } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
          updatedById: actorId,
          updatedBySnapshot: snapshot,
        },
      });
    }

    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_VERSION_SOFT_DELETE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: material.id,
      result: "SUCCESS",
      metadata: {
        scope: "VERSION",
        versionId: version.id,
        versionNumber: version.versionNumber,
        reason: input.reason ?? null,
        publishOutcome,
        rolledBackToVersionNumber: rolledBackToVersionNumber ?? null,
        deletedAt: deletedAt.toISOString(),
      },
    });

    return {
      materialId: material.id,
      versionId: version.id,
      deletedAt,
      publishOutcome,
      rolledBackToVersionNumber,
    };
  });
}

export async function softDeleteMaterial(
  actorId: string,
  materialId: string,
  options: MaterialOptions,
  input: { reason?: string } = {},
) {
  await authorizedActor(options.db, actorId);
  return options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const material = await loadActiveMaterial(transaction, materialId);
    const deletedAt = new Date();
    const activeVersionIds = material.versions.map((version) => version.id);

    await transaction.onboardingMaterial.update({
      where: { id: material.id },
      data: {
        deletedAt,
        deletedById: actorId,
        deletedBySnapshot: snapshot,
        statusBeforeDelete: material.status,
        status: OnboardingMaterialStatus.ARCHIVED,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
    });
    if (activeVersionIds.length > 0) {
      await transaction.onboardingMaterialVersion.updateMany({
        where: { id: { in: activeVersionIds } },
        data: {
          deletedAt,
          deletedById: actorId,
          deletedBySnapshot: snapshot,
        },
      });
    }

    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_SOFT_DELETE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: material.id,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        reason: input.reason ?? null,
        versionIds: activeVersionIds,
        statusBeforeDelete: material.status,
        deletedAt: deletedAt.toISOString(),
      },
    });

    return transaction.onboardingMaterial.findUniqueOrThrow({
      where: { id: material.id },
      include: materialInclude,
    });
  });
}

export async function listMaterialRecycleBin(actorId: string, options: MaterialOptions) {
  await authorizedActor(options.db, actorId);
  const [materials, versions] = await Promise.all([
    options.db.onboardingMaterial.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      include: materialInclude,
    }),
    options.db.onboardingMaterialVersion.findMany({
      where: {
        deletedAt: { not: null },
        material: { deletedAt: null },
      },
      orderBy: { deletedAt: "desc" },
      include: {
        material: { select: { id: true, title: true, category: true, status: true } },
      },
    }),
  ]);
  return { materials, versions };
}

export async function restoreMaterialVersion(
  actorId: string,
  materialId: string,
  versionId: string,
  options: MaterialOptions,
) {
  await authorizedActor(options.db, actorId);
  return options.db.$transaction(async (transaction) => {
    await authorizedActor(transaction, actorId);
    const material = await transaction.onboardingMaterial.findFirst({
      where: { id: materialId, deletedAt: null },
    });
    if (!material) throw new ContentRecycleError("NOT_FOUND", "资料不存在或整份已在回收站，请先恢复整份资料");
    const version = await transaction.onboardingMaterialVersion.findFirst({
      where: { id: versionId, materialId },
    });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "资料版本不存在");
    if (!version.deletedAt) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "资料版本不在回收站中");

    const restored = await transaction.onboardingMaterialVersion.update({
      where: { id: version.id },
      data: {
        deletedAt: null,
        deletedById: null,
        deletedBySnapshot: Prisma.DbNull,
      },
    });

    // If material has no current version, point to the restored one when it is the highest.
    if (!material.currentVersionId) {
      const latest = await transaction.onboardingMaterialVersion.findFirst({
        where: { materialId, deletedAt: null },
        orderBy: { versionNumber: "desc" },
      });
      if (latest) {
        await transaction.onboardingMaterial.update({
          where: { id: materialId },
          data: { currentVersionId: latest.id },
        });
      }
    }

    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_VERSION_RESTORE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: materialId,
      result: "SUCCESS",
      metadata: {
        scope: "VERSION",
        versionId: version.id,
        versionNumber: version.versionNumber,
        restoredAt: new Date().toISOString(),
      },
    });
    return restored;
  });
}

export async function restoreMaterial(
  actorId: string,
  materialId: string,
  options: MaterialOptions,
) {
  await authorizedActor(options.db, actorId);
  return options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const material = await transaction.onboardingMaterial.findFirst({
      where: { id: materialId, deletedAt: { not: null } },
      include: { versions: true },
    });
    if (!material) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "资料不在回收站中");

    const restoredVersionIds = material.versions
      .filter((version) => version.deletedAt !== null)
      .map((version) => version.id);

    if (restoredVersionIds.length > 0) {
      await transaction.onboardingMaterialVersion.updateMany({
        where: { id: { in: restoredVersionIds } },
        data: {
          deletedAt: null,
          deletedById: null,
          deletedBySnapshot: Prisma.DbNull,
        },
      });
    }

    const latest = await transaction.onboardingMaterialVersion.findFirst({
      where: { materialId, deletedAt: null },
      orderBy: { versionNumber: "desc" },
    });

    const restored = await transaction.onboardingMaterial.update({
      where: { id: materialId },
      data: {
        deletedAt: null,
        deletedById: null,
        deletedBySnapshot: Prisma.DbNull,
        statusBeforeDelete: null,
        status: OnboardingMaterialStatus.DRAFT,
        currentVersionId: latest?.id ?? null,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      },
      include: materialInclude,
    });

    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_RESTORE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: materialId,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        restoredVersionIds,
        restoredStatus: OnboardingMaterialStatus.DRAFT,
        restoredAt: new Date().toISOString(),
      },
    });
    return restored;
  });
}

async function hardDeleteMaterialVersions(
  transaction: Tx,
  versions: Array<{ id: string; fileAssetId: string }>,
) {
  if (versions.length === 0) return [] as string[];
  const versionIds = versions.map((version) => version.id);
  const assetIds = versions.map((version) => version.fileAssetId);
  const assets = await transaction.fileAsset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, storageKey: true },
  });

  // Detach mail template references so Restrict FKs do not block purge.
  await transaction.onboardingMailDraftAttachment.updateMany({
    where: { materialVersionId: { in: versionIds } },
    data: { materialVersionId: null },
  });
  await transaction.onboardingMailRevisionAttachment.updateMany({
    where: { materialVersionId: { in: versionIds } },
    data: { materialVersionId: null },
  });

  await transaction.onboardingMaterialVersion.deleteMany({
    where: { id: { in: versionIds } },
  });
  if (assets.length > 0) {
    await transaction.fileAsset.deleteMany({
      where: { id: { in: assets.map((asset) => asset.id) } },
    });
  }
  return assets.map((asset) => asset.storageKey);
}

export async function permanentlyDeleteMaterialVersion(
  actorId: string,
  materialId: string,
  versionId: string,
  options: MaterialOptions & { confirmed?: boolean },
) {
  if (!options.confirmed) throw new ContentRecycleError("CONFIRMATION_REQUIRED");
  await authorizedActor(options.db, actorId);

  const storageKeys = await options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const material = await transaction.onboardingMaterial.findFirst({
      where: { id: materialId, deletedAt: null },
    });
    if (!material) throw new ContentRecycleError("NOT_FOUND", "资料不存在或整份已在回收站");
    const version = await transaction.onboardingMaterialVersion.findFirst({
      where: { id: versionId, materialId },
    });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "资料版本不存在");
    if (!version.deletedAt) throw new ContentRecycleError("NOT_DELETED");

    if (material.currentVersionId === version.id) {
      const remaining = await transaction.onboardingMaterialVersion.findFirst({
        where: { materialId, deletedAt: null, id: { not: version.id } },
        orderBy: { versionNumber: "desc" },
      });
      await transaction.onboardingMaterial.update({
        where: { id: materialId },
        data: {
          currentVersionId: remaining?.id ?? null,
          updatedById: actorId,
          updatedBySnapshot: snapshot,
        },
      });
    }

    const keys = await hardDeleteMaterialVersions(transaction, [version]);
    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_VERSION_PERMANENT_DELETE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: materialId,
      result: "SUCCESS",
      metadata: {
        scope: "VERSION",
        versionId: version.id,
        versionNumber: version.versionNumber,
        permanentlyDeletedAt: new Date().toISOString(),
      },
    });
    return keys;
  });

  await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
  return { ok: true as const };
}

export async function permanentlyDeleteMaterial(
  actorId: string,
  materialId: string,
  options: MaterialOptions & { confirmed?: boolean },
) {
  if (!options.confirmed) throw new ContentRecycleError("CONFIRMATION_REQUIRED");
  await authorizedActor(options.db, actorId);

  const storageKeys = await options.db.$transaction(async (transaction) => {
    await authorizedActor(transaction, actorId);
    const material = await transaction.onboardingMaterial.findFirst({
      where: { id: materialId, deletedAt: { not: null } },
      include: { versions: true },
    });
    if (!material) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "资料不在回收站中");

    // Clear currentVersionId first to avoid self-referential FK issues.
    await transaction.onboardingMaterial.update({
      where: { id: materialId },
      data: { currentVersionId: null },
    });
    const keys = await hardDeleteMaterialVersions(transaction, material.versions);
    await transaction.onboardingMaterial.delete({ where: { id: materialId } });
    await writeAuditLog(transaction, {
      actorId,
      action: "ONBOARDING_MATERIAL_PERMANENT_DELETE",
      targetType: "ONBOARDING_MATERIAL",
      targetId: materialId,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        title: material.title,
        permanentlyDeletedAt: new Date().toISOString(),
      },
    });
    return keys;
  });

  await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
  return { ok: true as const };
}

export async function purgeExpiredMaterialRecycleBin(
  options: MaterialOptions,
  input: { now?: Date; retentionMs?: number } = {},
) {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? RECYCLE_RETENTION_MS;
  const cutoff = new Date(now.getTime() - retentionMs);

  const expiredMaterials = await options.db.onboardingMaterial.findMany({
    where: { deletedAt: { lte: cutoff } },
    select: { id: true },
  });
  const expiredOrphanVersions = await options.db.onboardingMaterialVersion.findMany({
    where: {
      deletedAt: { lte: cutoff },
      material: { deletedAt: null },
    },
    select: { id: true, materialId: true },
  });

  let purgedMaterials = 0;
  let purgedVersions = 0;

  for (const { id } of expiredMaterials) {
    const storageKeys = await options.db.$transaction(async (transaction) => {
      const material = await transaction.onboardingMaterial.findFirst({
        where: { id, deletedAt: { lte: cutoff } },
        include: { versions: true },
      });
      if (!material) return null;

      await transaction.onboardingMaterial.update({
        where: { id: material.id },
        data: { currentVersionId: null },
      });
      const keys = await hardDeleteMaterialVersions(transaction, material.versions);
      await transaction.onboardingMaterial.delete({ where: { id: material.id } });
      await writeAuditLog(transaction, {
        actorId: null,
        action: "ONBOARDING_MATERIAL_PERMANENT_DELETE",
        targetType: "ONBOARDING_MATERIAL",
        targetId: material.id,
        result: "SUCCESS",
        metadata: {
          scope: "WHOLE",
          title: material.title,
          trigger: "RETENTION_EXPIRED",
          permanentlyDeletedAt: now.toISOString(),
        },
      });
      return keys;
    });
    if (!storageKeys) continue;
    await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
    purgedMaterials += 1;
  }

  for (const { id, materialId } of expiredOrphanVersions) {
    const storageKeys = await options.db.$transaction(async (transaction) => {
      const version = await transaction.onboardingMaterialVersion.findFirst({
        where: {
          id,
          materialId,
          deletedAt: { lte: cutoff },
          material: { deletedAt: null },
        },
      });
      if (!version) return null;

      const keys = await hardDeleteMaterialVersions(transaction, [version]);
      await writeAuditLog(transaction, {
        actorId: null,
        action: "ONBOARDING_MATERIAL_VERSION_PERMANENT_DELETE",
        targetType: "ONBOARDING_MATERIAL",
        targetId: materialId,
        result: "SUCCESS",
        metadata: {
          scope: "VERSION",
          versionId: version.id,
          versionNumber: version.versionNumber,
          trigger: "RETENTION_EXPIRED",
          permanentlyDeletedAt: now.toISOString(),
        },
      });
      return keys;
    });
    if (!storageKeys) continue;
    await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
    purgedVersions += 1;
  }

  if (purgedMaterials > 0 || purgedVersions > 0) {
    await writeAuditLog(options.db, {
      actorId: null,
      action: "ONBOARDING_MATERIAL_RECYCLE_PURGE",
      targetType: "ONBOARDING_MATERIAL",
      result: "SUCCESS",
      metadata: {
        purgedMaterials,
        purgedVersions,
        cutoff: cutoff.toISOString(),
        purgedAt: now.toISOString(),
      },
    });
  }

  return { purgedMaterials, purgedVersions, cutoff };
}

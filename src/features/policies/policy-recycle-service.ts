import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { PolicyStatus, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import {
  RECYCLE_RETENTION_MS,
  type PublishOutcome,
} from "@/features/content-recycle/constants";
import { ContentRecycleError } from "@/features/content-recycle/errors";
import { unlinkPrivateStorageKeys } from "@/features/content-recycle/storage-cleanup";

type PolicyDb = PrismaClient;
type Tx = Prisma.TransactionClient;

export type PolicyRecycleOptions = {
  actorId: string;
  policyId: string;
  privateRoot: string;
  reason?: string;
  confirmed?: boolean;
};

export type PolicyVersionRecycleOptions = PolicyRecycleOptions & {
  versionId: string;
};

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

function activeVersionsOrder(): Prisma.PolicyVersionOrderByWithRelationInput[] {
  return [{ createdAt: "desc" }, { id: "desc" }];
}

async function loadActivePolicy(transaction: Tx, policyId: string) {
  const policy = await transaction.policy.findFirst({
    where: { id: policyId, deletedAt: null },
    include: {
      versions: {
        where: { deletedAt: null },
        orderBy: activeVersionsOrder(),
      },
    },
  });
  if (!policy) throw new ContentRecycleError("NOT_FOUND", "制度不存在或已进入回收站");
  return policy;
}

function computeVersionDeleteOutcome(
  policyStatus: PolicyStatus,
  deletedVersionId: string,
  activeVersionsNewestFirst: Array<{ id: string; versionNumber: string }>,
): { publishOutcome: PublishOutcome; rolledBackToVersionNumber?: string; nextStatus?: PolicyStatus } {
  const isNewest = activeVersionsNewestFirst[0]?.id === deletedVersionId;
  if (!isNewest || policyStatus !== PolicyStatus.PUBLISHED) {
    return { publishOutcome: "UNCHANGED" };
  }
  const remaining = activeVersionsNewestFirst.filter((version) => version.id !== deletedVersionId);
  if (remaining[0]) {
    return {
      publishOutcome: "ROLLED_BACK",
      rolledBackToVersionNumber: remaining[0].versionNumber,
    };
  }
  return { publishOutcome: "UNPUBLISHED", nextStatus: PolicyStatus.ARCHIVED };
}

export async function softDeletePolicyVersion(
  db: PolicyDb,
  options: PolicyVersionRecycleOptions,
) {
  await authorizedActor(db, options.actorId);
  return db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, options.actorId);
    const policy = await loadActivePolicy(transaction, options.policyId);
    const version = policy.versions.find((item) => item.id === options.versionId)
      ?? await transaction.policyVersion.findFirst({
        where: { id: options.versionId, policyId: options.policyId },
      });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "制度版本不存在");
    if (version.deletedAt) throw new ContentRecycleError("ALREADY_DELETED", "制度版本已在回收站中");

    const active = policy.versions;
    const outcome = computeVersionDeleteOutcome(policy.status, version.id, active);
    const deletedAt = new Date();

    await transaction.policyVersion.update({
      where: { id: version.id },
      data: {
        deletedAt,
        deletedById: options.actorId,
        deletedBySnapshot: snapshot,
      },
    });

    if (outcome.nextStatus) {
      await transaction.policy.update({
        where: { id: policy.id },
        data: { status: outcome.nextStatus },
      });
    }

    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_VERSION_SOFT_DELETE",
      targetType: "POLICY",
      targetId: policy.id,
      result: "SUCCESS",
      metadata: {
        scope: "VERSION",
        versionId: version.id,
        versionNumber: version.versionNumber,
        reason: options.reason ?? null,
        publishOutcome: outcome.publishOutcome,
        rolledBackToVersionNumber: outcome.rolledBackToVersionNumber ?? null,
        deletedAt: deletedAt.toISOString(),
      },
    });

    return {
      policyId: policy.id,
      versionId: version.id,
      deletedAt,
      ...outcome,
    };
  });
}

export async function softDeletePolicy(db: PolicyDb, options: PolicyRecycleOptions) {
  await authorizedActor(db, options.actorId);
  return db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, options.actorId);
    const policy = await loadActivePolicy(transaction, options.policyId);
    const deletedAt = new Date();
    const activeVersionIds = policy.versions.map((version) => version.id);

    await transaction.policy.update({
      where: { id: policy.id },
      data: {
        deletedAt,
        deletedById: options.actorId,
        deletedBySnapshot: snapshot,
        statusBeforeDelete: policy.status,
        status: PolicyStatus.ARCHIVED,
      },
    });
    if (activeVersionIds.length > 0) {
      await transaction.policyVersion.updateMany({
        where: { id: { in: activeVersionIds } },
        data: {
          deletedAt,
          deletedById: options.actorId,
          deletedBySnapshot: snapshot,
        },
      });
    }

    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_SOFT_DELETE",
      targetType: "POLICY",
      targetId: policy.id,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        reason: options.reason ?? null,
        versionIds: activeVersionIds,
        statusBeforeDelete: policy.status,
        deletedAt: deletedAt.toISOString(),
      },
    });

    return transaction.policy.findUniqueOrThrow({
      where: { id: policy.id },
      include: { versions: { orderBy: activeVersionsOrder() } },
    });
  });
}

export async function listPolicyRecycleBin(db: PolicyDb, actorId: string) {
  await authorizedActor(db, actorId);
  const [policies, orphanVersions] = await Promise.all([
    db.policy.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      include: {
        versions: { orderBy: activeVersionsOrder() },
      },
    }),
    db.policyVersion.findMany({
      where: {
        deletedAt: { not: null },
        policy: { deletedAt: null },
      },
      orderBy: { deletedAt: "desc" },
      include: {
        policy: { select: { id: true, name: true, category: true, status: true } },
      },
    }),
  ]);
  return { policies, versions: orphanVersions };
}

export async function restorePolicyVersion(db: PolicyDb, options: PolicyVersionRecycleOptions) {
  await authorizedActor(db, options.actorId);
  return db.$transaction(async (transaction) => {
    await authorizedActor(transaction, options.actorId);
    const policy = await transaction.policy.findFirst({
      where: { id: options.policyId, deletedAt: null },
    });
    if (!policy) throw new ContentRecycleError("NOT_FOUND", "制度不存在或整份已在回收站，请先恢复整份资料");
    const version = await transaction.policyVersion.findFirst({
      where: { id: options.versionId, policyId: options.policyId },
    });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "制度版本不存在");
    if (!version.deletedAt) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "制度版本不在回收站中");

    const restored = await transaction.policyVersion.update({
      where: { id: version.id },
      data: {
        deletedAt: null,
        deletedById: null,
        deletedBySnapshot: Prisma.DbNull,
      },
    });

    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_VERSION_RESTORE",
      targetType: "POLICY",
      targetId: policy.id,
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

export async function restorePolicy(db: PolicyDb, options: PolicyRecycleOptions) {
  await authorizedActor(db, options.actorId);
  return db.$transaction(async (transaction) => {
    await authorizedActor(transaction, options.actorId);
    const policy = await transaction.policy.findFirst({
      where: { id: options.policyId, deletedAt: { not: null } },
      include: { versions: true },
    });
    if (!policy) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "制度不在回收站中");

    const restoredVersionIds = policy.versions
      .filter((version) => version.deletedAt !== null)
      .map((version) => version.id);

    await transaction.policy.update({
      where: { id: policy.id },
      data: {
        deletedAt: null,
        deletedById: null,
        deletedBySnapshot: Prisma.DbNull,
        statusBeforeDelete: null,
        // Safe default: never re-publish on restore.
        status: PolicyStatus.DRAFT,
      },
    });
    if (restoredVersionIds.length > 0) {
      await transaction.policyVersion.updateMany({
        where: { id: { in: restoredVersionIds } },
        data: {
          deletedAt: null,
          deletedById: null,
          deletedBySnapshot: Prisma.DbNull,
        },
      });
    }

    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_RESTORE",
      targetType: "POLICY",
      targetId: policy.id,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        restoredVersionIds,
        restoredStatus: PolicyStatus.DRAFT,
        restoredAt: new Date().toISOString(),
      },
    });

    return transaction.policy.findUniqueOrThrow({
      where: { id: policy.id },
      include: { versions: { orderBy: activeVersionsOrder() } },
    });
  });
}

async function collectVersionStorageKeys(
  transaction: Tx,
  versions: Array<{ fileAssetId: string; previewAssetId: string | null }>,
) {
  const assetIds = [
    ...versions.map((version) => version.fileAssetId),
    ...versions.map((version) => version.previewAssetId).filter((id): id is string => Boolean(id)),
  ];
  if (assetIds.length === 0) return { assetIds: [] as string[], storageKeys: [] as string[] };
  const assets = await transaction.fileAsset.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, storageKey: true },
  });
  return {
    assetIds: assets.map((asset) => asset.id),
    storageKeys: assets.map((asset) => asset.storageKey),
  };
}

async function hardDeletePolicyVersions(
  transaction: Tx,
  versions: Array<{ id: string; fileAssetId: string; previewAssetId: string | null }>,
) {
  if (versions.length === 0) return [] as string[];
  const { assetIds, storageKeys } = await collectVersionStorageKeys(transaction, versions);
  await transaction.policyVersion.deleteMany({
    where: { id: { in: versions.map((version) => version.id) } },
  });
  if (assetIds.length > 0) {
    await transaction.fileAsset.deleteMany({ where: { id: { in: assetIds } } });
  }
  return storageKeys;
}

export async function permanentlyDeletePolicyVersion(
  db: PolicyDb,
  options: PolicyVersionRecycleOptions,
) {
  if (!options.confirmed) throw new ContentRecycleError("CONFIRMATION_REQUIRED");
  await authorizedActor(db, options.actorId);

  const storageKeys = await db.$transaction(async (transaction) => {
    await authorizedActor(transaction, options.actorId);
    const policy = await transaction.policy.findFirst({
      where: { id: options.policyId, deletedAt: null },
    });
    if (!policy) throw new ContentRecycleError("NOT_FOUND", "制度不存在或整份已在回收站");
    const version = await transaction.policyVersion.findFirst({
      where: { id: options.versionId, policyId: options.policyId },
    });
    if (!version) throw new ContentRecycleError("NOT_FOUND", "制度版本不存在");
    if (!version.deletedAt) throw new ContentRecycleError("NOT_DELETED");

    const keys = await hardDeletePolicyVersions(transaction, [version]);
    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_VERSION_PERMANENT_DELETE",
      targetType: "POLICY",
      targetId: policy.id,
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

export async function permanentlyDeletePolicy(db: PolicyDb, options: PolicyRecycleOptions) {
  if (!options.confirmed) throw new ContentRecycleError("CONFIRMATION_REQUIRED");
  await authorizedActor(db, options.actorId);

  const storageKeys = await db.$transaction(async (transaction) => {
    await authorizedActor(transaction, options.actorId);
    const policy = await transaction.policy.findFirst({
      where: { id: options.policyId, deletedAt: { not: null } },
      include: { versions: true },
    });
    if (!policy) throw new ContentRecycleError("NOT_IN_RECYCLE_BIN", "制度不在回收站中");

    const keys = await hardDeletePolicyVersions(transaction, policy.versions);
    await transaction.policy.delete({ where: { id: policy.id } });
    await writeAuditLog(transaction, {
      actorId: options.actorId,
      action: "POLICY_PERMANENT_DELETE",
      targetType: "POLICY",
      targetId: policy.id,
      result: "SUCCESS",
      metadata: {
        scope: "WHOLE",
        name: policy.name,
        permanentlyDeletedAt: new Date().toISOString(),
      },
    });
    return keys;
  });

  await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
  return { ok: true as const };
}

export async function purgeExpiredPolicyRecycleBin(
  db: PolicyDb,
  options: { privateRoot: string; now?: Date; retentionMs?: number },
) {
  const now = options.now ?? new Date();
  const retentionMs = options.retentionMs ?? RECYCLE_RETENTION_MS;
  const cutoff = new Date(now.getTime() - retentionMs);

  const expiredPolicies = await db.policy.findMany({
    where: { deletedAt: { lte: cutoff } },
    select: { id: true },
  });
  const expiredOrphanVersions = await db.policyVersion.findMany({
    where: {
      deletedAt: { lte: cutoff },
      policy: { deletedAt: null },
    },
    select: { id: true, policyId: true },
  });

  let purgedPolicies = 0;
  let purgedVersions = 0;

  for (const { id } of expiredPolicies) {
    const storageKeys = await db.$transaction(async (transaction) => {
      const policy = await transaction.policy.findFirst({
        where: { id, deletedAt: { lte: cutoff } },
        include: { versions: true },
      });
      if (!policy) return null;

      const keys = await hardDeletePolicyVersions(transaction, policy.versions);
      await transaction.policy.delete({ where: { id: policy.id } });
      await writeAuditLog(transaction, {
        actorId: null,
        action: "POLICY_PERMANENT_DELETE",
        targetType: "POLICY",
        targetId: policy.id,
        result: "SUCCESS",
        metadata: {
          scope: "WHOLE",
          name: policy.name,
          trigger: "RETENTION_EXPIRED",
          permanentlyDeletedAt: now.toISOString(),
        },
      });
      return keys;
    });
    if (!storageKeys) continue;
    await unlinkPrivateStorageKeys(storageKeys, options.privateRoot);
    purgedPolicies += 1;
  }

  for (const { id, policyId } of expiredOrphanVersions) {
    const storageKeys = await db.$transaction(async (transaction) => {
      const version = await transaction.policyVersion.findFirst({
        where: {
          id,
          policyId,
          deletedAt: { lte: cutoff },
          policy: { deletedAt: null },
        },
      });
      if (!version) return null;

      const keys = await hardDeletePolicyVersions(transaction, [version]);
      await writeAuditLog(transaction, {
        actorId: null,
        action: "POLICY_VERSION_PERMANENT_DELETE",
        targetType: "POLICY",
        targetId: policyId,
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

  if (purgedPolicies > 0 || purgedVersions > 0) {
    await writeAuditLog(db, {
      actorId: null,
      action: "POLICY_RECYCLE_PURGE",
      targetType: "POLICY",
      result: "SUCCESS",
      metadata: {
        purgedPolicies,
        purgedVersions,
        cutoff: cutoff.toISOString(),
        purgedAt: now.toISOString(),
      },
    });
  }

  return { purgedPolicies, purgedVersions, cutoff };
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { City, FileAssetKind, PolicyPreviewStatus, PolicyStatus, UserStatus } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import {
  PolicyFileError,
  validatePolicyFile,
  type PolicyFileInput,
} from "@/features/policies/file-validation";
import {
  generatePolicyPreview,
  type PolicyPreviewOptions,
} from "@/features/policies/document-preview-service";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export { PolicyFileError };

export class PolicyStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyStateError";
  }
}

async function storeOriginal(
  file: PolicyFileInput,
  privateRoot: string,
) {
  const extension = path.extname(file.fileName).toLowerCase();
  const storageKey = path.posix.join("assets", "policies", "originals", `${randomUUID()}${extension}`);
  const absolutePath = path.resolve(privateRoot, storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, file.bytes);
  return {
    storageKey,
    absolutePath,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

type CreatePolicyInput = {
  name: string;
  category: string;
  /** @deprecated 发布范围已固定为全体在职员工；仅保留该输入兼容旧调用方。 */
  applicableCities?: City[];
  versionNumber: string;
  effectiveDate: Date;
  file: PolicyFileInput;
  actorId: string;
  privateRoot?: string;
  maxBytes?: number;
  previewOptions?: Omit<PolicyPreviewOptions, "privateRoot">;
};

export async function createPolicy(db: PrismaClient, input: CreatePolicyInput) {
  const descriptor = validatePolicyFile(input.file, input.maxBytes);
  if (!input.name.trim() || !input.category.trim()) {
    throw new Error("制度名称和分类不能为空");
  }
  const privateRoot = input.privateRoot ?? defaultPrivateRoot;
  const stored = await storeOriginal(input.file, privateRoot);
  let created: { policy: Awaited<ReturnType<PrismaClient["policy"]["create"]>> & { versions: Array<{ id: string }> }; versionId: string };
  try {
    created = await db.$transaction(async (transaction) => {
      const actor = await transaction.user.findUniqueOrThrow({
        where: { id: input.actorId },
        select: { id: true, employeeNo: true, name: true, email: true, role: true },
      });
      const asset = await transaction.fileAsset.create({
        data: {
          kind: FileAssetKind.POLICY_FILE,
          storageKey: stored.storageKey,
          originalName: path.basename(input.file.fileName),
          mimeType: descriptor.mimeType,
          sizeBytes: input.file.bytes.byteLength,
          sha256: stored.sha256,
          uploadedById: input.actorId,
          uploadedBySnapshot: snapshotUserIdentity(actor),
        },
      });
      const policy = await transaction.policy.create({
        data: {
          name: input.name.trim(),
          category: input.category.trim(),
          // The column is retained for old data compatibility, but new policies are company-wide.
          applicableCities: [] as unknown as Prisma.InputJsonValue,
          versions: {
            create: {
              versionNumber: input.versionNumber,
              effectiveDate: input.effectiveDate,
              fileAssetId: asset.id,
            },
          },
        },
        include: { versions: true },
      });
      await writeAuditLog(transaction, {
        actorId: input.actorId,
        action: "POLICY_CREATE",
        targetType: "POLICY",
        targetId: policy.id,
        result: "SUCCESS",
        metadata: { versionNumber: input.versionNumber },
      });
      return { policy, versionId: policy.versions[0]!.id };
    });
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
  await generatePolicyPreview(db, created.versionId, {
    privateRoot,
    ...input.previewOptions,
  });
  return created.policy;
}

export async function replacePolicyVersion(
  db: PrismaClient,
  policyId: string,
  input: {
    versionNumber: string;
    effectiveDate: Date;
    file: PolicyFileInput;
    actorId: string;
    privateRoot?: string;
    maxBytes?: number;
    previewOptions?: Omit<PolicyPreviewOptions, "privateRoot">;
  },
) {
  const descriptor = validatePolicyFile(input.file, input.maxBytes);
  const privateRoot = input.privateRoot ?? defaultPrivateRoot;
  const stored = await storeOriginal(input.file, privateRoot);
  let version: Awaited<ReturnType<PrismaClient["policyVersion"]["create"]>>;
  try {
    version = await db.$transaction(async (transaction) => {
      const actor = await transaction.user.findUniqueOrThrow({
        where: { id: input.actorId },
        select: { id: true, employeeNo: true, name: true, email: true, role: true },
      });
      const asset = await transaction.fileAsset.create({
        data: {
          kind: FileAssetKind.POLICY_FILE,
          storageKey: stored.storageKey,
          originalName: path.basename(input.file.fileName),
          mimeType: descriptor.mimeType,
          sizeBytes: input.file.bytes.byteLength,
          sha256: stored.sha256,
          uploadedById: input.actorId,
          uploadedBySnapshot: snapshotUserIdentity(actor),
        },
      });
      const version = await transaction.policyVersion.create({
        data: {
          policyId,
          versionNumber: input.versionNumber,
          effectiveDate: input.effectiveDate,
          fileAssetId: asset.id,
        },
      });
      await writeAuditLog(transaction, {
        actorId: input.actorId,
        action: "POLICY_VERSION_CREATE",
        targetType: "POLICY",
        targetId: policyId,
        result: "SUCCESS",
        metadata: { versionNumber: input.versionNumber },
      });
      return version;
    });
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
  await generatePolicyPreview(db, version.id, {
    privateRoot,
    ...input.previewOptions,
  });
  return version;
}

export async function setPolicyStatus(
  db: PrismaClient,
  policyId: string,
  status: PolicyStatus,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    if (status === PolicyStatus.PUBLISHED) {
      const candidate = await transaction.policy.findFirst({
        where: { id: policyId, deletedAt: null },
        include: {
          versions: {
            where: { deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });
      if (!candidate) throw new PolicyStateError("制度不存在或已进入回收站");
      if (candidate.versions[0]?.previewStatus !== PolicyPreviewStatus.READY) {
        throw new PolicyStateError("最新制度版本的预览尚未生成成功，不能发布");
      }
    }
    const policy = await transaction.policy.update({ where: { id: policyId }, data: { status } });
    await writeAuditLog(transaction, {
      actorId,
      action: "POLICY_STATUS_CHANGE",
      targetType: "POLICY",
      targetId: policyId,
      result: "SUCCESS",
      metadata: { status },
    });
    return policy;
  });
}

export async function setPolicySortOrder(
  db: PrismaClient,
  policyId: string,
  sortOrder: number,
  actorId: string,
) {
  if (!Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new Error("制度顺序必须是大于或等于 0 的整数");
  }
  return db.$transaction(async (transaction) => {
    const policy = await transaction.policy.update({
      where: { id: policyId },
      data: { sortOrder },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "POLICY_SORT_CHANGE",
      targetType: "POLICY",
      targetId: policyId,
      result: "SUCCESS",
      metadata: { sortOrder },
    });
    return policy;
  });
}

export async function listPoliciesForEmployee(db: PrismaClient, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { enabled: true, status: true },
  });
  if (!user?.enabled || user.status !== UserStatus.ACTIVE) return [];
  return db.policy.findMany({
    where: {
      status: PolicyStatus.PUBLISHED,
      deletedAt: null,
      versions: {
        some: { deletedAt: null, previewStatus: PolicyPreviewStatus.READY },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
    include: {
      versions: {
        where: { deletedAt: null, previewStatus: PolicyPreviewStatus.READY },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
}

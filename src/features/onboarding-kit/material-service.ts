import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { FileAssetKind, OnboardingMaterialStatus, Role } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { writeAuditLog } from "@/features/audit/audit-service";
import { AuthError } from "@/features/auth/errors";
import { validateOnboardingUpload } from "@/features/onboarding-kit/file-validation";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { materialInputSchema, type MaterialInput } from "@/features/onboarding-kit/schemas";
import { storeOnboardingUpload } from "@/features/onboarding-kit/storage";

type MaterialDb = PrismaClient;
type MaterialOptions = { db: MaterialDb; privateRoot: string; maxBytes: number };

async function authorizedActor(db: Pick<PrismaClient, "user"> | Prisma.TransactionClient, actorId: string) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  if (actor.role !== Role.ADMIN && actor.role !== Role.SUPER_ADMIN) throw new AuthError("FORBIDDEN", 403);
  return { actor, snapshot: snapshotUserIdentity(actor) };
}

const materialInclude = { currentVersion: true, versions: { orderBy: { versionNumber: "asc" as const } } };

async function storedUpload(file: UploadFileLike, options: MaterialOptions) {
  const validated = await validateOnboardingUpload(file, { maxBytes: options.maxBytes });
  try {
    return { validated, stored: await storeOnboardingUpload(validated, options.privateRoot) };
  } catch (error) {
    await validated.cleanup();
    throw error;
  }
}

export async function createMaterial(actorId: string, input: MaterialInput, file: UploadFileLike, options: MaterialOptions) {
  await authorizedActor(options.db, actorId);
  const metadata = materialInputSchema.parse(input);
  const upload = await storedUpload(file, options);
  try {
    return await options.db.$transaction(async (transaction) => {
      const { snapshot } = await authorizedActor(transaction, actorId);
      const asset = await transaction.fileAsset.create({ data: {
        kind: FileAssetKind.ONBOARDING_MATERIAL,
        storageKey: upload.stored.storageKey,
        originalName: upload.validated.originalName,
        mimeType: upload.validated.mimeType,
        sizeBytes: upload.validated.sizeBytes,
        sha256: upload.validated.sha256,
        uploadedById: actorId,
        uploadedBySnapshot: snapshot,
      } });
      const material = await transaction.onboardingMaterial.create({ data: {
        ...metadata,
        description: metadata.description || null,
        createdById: actorId,
        createdBySnapshot: snapshot,
        updatedById: actorId,
        updatedBySnapshot: snapshot,
      } });
      const version = await transaction.onboardingMaterialVersion.create({ data: {
        materialId: material.id,
        versionNumber: 1,
        fileAssetId: asset.id,
        originalName: upload.validated.originalName,
        displayName: upload.validated.originalName,
        extension: upload.validated.extension,
        mimeType: upload.validated.mimeType,
        sizeBytes: upload.validated.sizeBytes,
        sha256: upload.validated.sha256,
        uploadedById: actorId,
        uploadedBySnapshot: snapshot,
      } });
      await transaction.onboardingMaterial.update({ where: { id: material.id }, data: { currentVersionId: version.id } });
      await writeAuditLog(transaction, {
        actorId,
        action: "ONBOARDING_MATERIAL_CREATE",
        targetType: "ONBOARDING_MATERIAL",
        targetId: material.id,
        result: "SUCCESS",
        metadata: { versionNumber: 1, originalName: upload.validated.originalName },
      });
      return transaction.onboardingMaterial.findUniqueOrThrow({ where: { id: material.id }, include: materialInclude });
    });
  } catch (error) {
    await upload.stored.cleanup();
    throw error;
  } finally {
    await upload.validated.cleanup();
  }
}

const replacementQueues = new WeakMap<MaterialDb, Map<string, Promise<unknown>>>();

async function serializeReplacement<T>(db: MaterialDb, materialId: string, operation: () => Promise<T>) {
  const queues = replacementQueues.get(db) ?? new Map<string, Promise<unknown>>();
  replacementQueues.set(db, queues);
  const previous = queues.get(materialId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(materialId, current);
  try { return await current; }
  finally { if (queues.get(materialId) === current) queues.delete(materialId); }
}

export async function replaceMaterialFile(actorId: string, materialId: string, file: UploadFileLike, options: MaterialOptions) {
  await authorizedActor(options.db, actorId);
  const upload = await storedUpload(file, options);
  try {
    return await serializeReplacement(options.db, materialId, () => options.db.$transaction(async (transaction) => {
      const { snapshot } = await authorizedActor(transaction, actorId);
      await transaction.onboardingMaterial.findUniqueOrThrow({ where: { id: materialId }, select: { id: true } });
      const latest = await transaction.onboardingMaterialVersion.findFirst({
        where: { materialId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true },
      });
      const asset = await transaction.fileAsset.create({ data: {
        kind: FileAssetKind.ONBOARDING_MATERIAL,
        storageKey: upload.stored.storageKey,
        originalName: upload.validated.originalName,
        mimeType: upload.validated.mimeType,
        sizeBytes: upload.validated.sizeBytes,
        sha256: upload.validated.sha256,
        uploadedById: actorId,
        uploadedBySnapshot: snapshot,
      } });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      const version = await transaction.onboardingMaterialVersion.create({ data: {
        materialId,
        versionNumber,
        fileAssetId: asset.id,
        originalName: upload.validated.originalName,
        displayName: upload.validated.originalName,
        extension: upload.validated.extension,
        mimeType: upload.validated.mimeType,
        sizeBytes: upload.validated.sizeBytes,
        sha256: upload.validated.sha256,
        uploadedById: actorId,
        uploadedBySnapshot: snapshot,
      } });
      await transaction.onboardingMaterial.update({
        where: { id: materialId },
        data: { currentVersionId: version.id, updatedById: actorId, updatedBySnapshot: snapshot },
      });
      await writeAuditLog(transaction, {
        actorId, action: "ONBOARDING_MATERIAL_FILE_REPLACE", targetType: "ONBOARDING_MATERIAL",
        targetId: materialId, result: "SUCCESS", metadata: { versionNumber, originalName: upload.validated.originalName },
      });
      return transaction.onboardingMaterial.findUniqueOrThrow({ where: { id: materialId }, include: materialInclude });
    }));
  } catch (error) {
    await upload.stored.cleanup();
    throw error;
  } finally {
    await upload.validated.cleanup();
  }
}

export async function updateMaterial(actorId: string, materialId: string, input: MaterialInput, options: MaterialOptions) {
  const metadata = materialInputSchema.parse(input);
  return options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const updated = await transaction.onboardingMaterial.update({
      where: { id: materialId },
      data: { ...metadata, description: metadata.description || null, updatedById: actorId, updatedBySnapshot: snapshot },
      include: materialInclude,
    });
    await writeAuditLog(transaction, {
      actorId, action: "ONBOARDING_MATERIAL_UPDATE", targetType: "ONBOARDING_MATERIAL",
      targetId: materialId, result: "SUCCESS",
    });
    return updated;
  });
}

async function transitionMaterial(
  actorId: string,
  materialId: string,
  status: OnboardingMaterialStatus,
  action: "ONBOARDING_MATERIAL_PUBLISH" | "ONBOARDING_MATERIAL_ARCHIVE",
  options: MaterialOptions,
) {
  return options.db.$transaction(async (transaction) => {
    const { snapshot } = await authorizedActor(transaction, actorId);
    const existing = await transaction.onboardingMaterial.findUniqueOrThrow({
      where: { id: materialId }, select: { currentVersionId: true },
    });
    if (!existing.currentVersionId) throw new Error("资料没有可发布的文件版本");
    const updated = await transaction.onboardingMaterial.update({
      where: { id: materialId },
      data: { status, updatedById: actorId, updatedBySnapshot: snapshot },
      include: materialInclude,
    });
    await writeAuditLog(transaction, {
      actorId, action, targetType: "ONBOARDING_MATERIAL", targetId: materialId, result: "SUCCESS",
    });
    return updated;
  });
}

export function publishMaterial(actorId: string, materialId: string, options: MaterialOptions) {
  return transitionMaterial(actorId, materialId, OnboardingMaterialStatus.PUBLISHED, "ONBOARDING_MATERIAL_PUBLISH", options);
}

export function archiveMaterial(actorId: string, materialId: string, options: MaterialOptions) {
  return transitionMaterial(actorId, materialId, OnboardingMaterialStatus.ARCHIVED, "ONBOARDING_MATERIAL_ARCHIVE", options);
}

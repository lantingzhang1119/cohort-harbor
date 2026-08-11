import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { City, FileAssetKind, WorkLocation } from "@/generated/prisma/enums";
import { writeAuditLog } from "@/features/audit/audit-service";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { validateGuideImage, type GuideImageInput } from "@/features/guides/guide-file-validation";
import {
  updateGuideSchema,
  guideChapterSchema,
  type GuideChapterInput,
  type UpdateGuideInput,
} from "@/features/guides/guide-schemas";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

const locationToCity: Partial<Record<WorkLocation, City>> = {
  SHANGHAI: City.SHANGHAI,
  SHENZHEN: City.SHENZHEN,
  CHANGSHA: City.CHANGSHA,
  XIAN: City.XIAN,
};

async function loadActorSnapshot(
  db: Pick<PrismaClient, "user"> | Prisma.TransactionClient,
  actorId: string,
) {
  const actor = await db.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { id: true, employeeNo: true, name: true, email: true, role: true },
  });
  return snapshotUserIdentity(actor);
}

export async function listGuidesForEmployee(db: PrismaClient, userId: string) {
  const [user, guides] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { workLocation: true } }),
    db.cityGuide.findMany({
      where: { enabled: true },
      orderBy: { city: "asc" },
      select: { id: true, city: true, title: true, summary: true },
    }),
  ]);
  const recommendedCity = locationToCity[user.workLocation];
  return guides
    .map((guide) => ({ ...guide, recommended: guide.city === recommendedCity }))
    .sort((left, right) => Number(right.recommended) - Number(left.recommended));
}

export async function getGuideForEmployee(
  db: PrismaClient,
  userId: string,
  city: City,
) {
  await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true } });
  return db.cityGuide.findFirstOrThrow({
    where: { city, enabled: true },
    include: {
      chapters: {
        where: { enabled: true },
        orderBy: { sortOrder: "asc" },
        include: { imageAsset: { select: { id: true, mimeType: true } } },
      },
    },
  });
}

export async function updateGuide(
  db: PrismaClient,
  city: City,
  input: UpdateGuideInput,
  actorId: string,
) {
  const parsed = updateGuideSchema.parse(input);
  return db.$transaction(async (transaction) => {
    const actorSnapshot = await loadActorSnapshot(transaction, actorId);
    const before = await transaction.cityGuide.findUnique({
      where: { city },
      include: { chapters: { orderBy: { sortOrder: "asc" } } },
    });
    const guide = await transaction.cityGuide.upsert({
      where: { city },
      create: { city, ...parsed },
      update: parsed,
    });
    await transaction.guideRevision.create({
      data: {
        guideId: guide.id,
        actorId,
        actorSnapshot,
        summary: before ? "更新指南基本信息" : "创建指南",
        snapshot: (before ?? { city }) as unknown as Prisma.InputJsonValue,
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: "GUIDE_UPDATE",
      targetType: "CITY_GUIDE",
      targetId: guide.id,
      result: "SUCCESS",
      metadata: { city },
    });
    return guide;
  });
}

export async function listGuideForAdmin(db: PrismaClient, city: City) {
  return db.cityGuide.findUniqueOrThrow({
    where: { city },
    include: {
      chapters: {
        orderBy: { sortOrder: "asc" },
        include: { imageAsset: { select: { id: true, originalName: true, mimeType: true } } },
      },
      revisions: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
}

export async function upsertGuideChapter(
  db: PrismaClient,
  city: City,
  chapterId: string | null,
  input: GuideChapterInput,
  actorId: string,
) {
  const parsed = guideChapterSchema.parse(input);
  return db.$transaction(async (transaction) => {
    const actorSnapshot = await loadActorSnapshot(transaction, actorId);
    const guide = await transaction.cityGuide.findUniqueOrThrow({ where: { city } });
    const before = chapterId
      ? await transaction.guideChapter.findFirst({ where: { id: chapterId, guideId: guide.id } })
      : null;
    if (chapterId && !before) throw new Error("指南章节不存在");
    const chapter = before
      ? await transaction.guideChapter.update({ where: { id: before.id }, data: parsed })
      : await transaction.guideChapter.create({ data: { guideId: guide.id, ...parsed } });
    await transaction.guideRevision.create({
      data: {
        guideId: guide.id,
        actorId,
        actorSnapshot,
        summary: before ? `更新章节：${chapter.title}` : `新增章节：${chapter.title}`,
        snapshot: (before ?? { chapterId: chapter.id, created: true }) as unknown as Prisma.InputJsonValue,
      },
    });
    await writeAuditLog(transaction, {
      actorId,
      action: before ? "GUIDE_CHAPTER_UPDATE" : "GUIDE_CHAPTER_CREATE",
      targetType: "GUIDE_CHAPTER",
      targetId: chapter.id,
      result: "SUCCESS",
      metadata: { city },
    });
    return chapter;
  });
}

export async function reorderGuideChapters(
  db: PrismaClient,
  city: City,
  chapterIds: string[],
  actorId: string,
) {
  if (new Set(chapterIds).size !== chapterIds.length) throw new Error("章节排序中存在重复项");
  return db.$transaction(async (transaction) => {
    const actorSnapshot = await loadActorSnapshot(transaction, actorId);
    const guide = await transaction.cityGuide.findUniqueOrThrow({ where: { city } });
    const chapters = await transaction.guideChapter.findMany({ where: { guideId: guide.id } });
    if (chapters.length !== chapterIds.length || chapters.some((chapter) => !chapterIds.includes(chapter.id))) {
      throw new Error("章节排序列表不完整");
    }
    for (const [index, id] of chapterIds.entries()) {
      await transaction.guideChapter.update({ where: { id }, data: { sortOrder: index + 1 } });
    }
    await transaction.guideRevision.create({
      data: { guideId: guide.id, actorId, actorSnapshot, summary: "调整章节顺序", snapshot: chapterIds as Prisma.InputJsonValue },
    });
    await writeAuditLog(transaction, { actorId, action: "GUIDE_CHAPTER_REORDER", targetType: "CITY_GUIDE", targetId: guide.id, result: "SUCCESS", metadata: { city, count: chapterIds.length } });
    return chapterIds.length;
  });
}

export async function deleteGuideChapter(
  db: PrismaClient,
  city: City,
  chapterId: string,
  actorId: string,
) {
  return db.$transaction(async (transaction) => {
    const actorSnapshot = await loadActorSnapshot(transaction, actorId);
    const guide = await transaction.cityGuide.findUniqueOrThrow({ where: { city } });
    const chapter = await transaction.guideChapter.findFirstOrThrow({ where: { id: chapterId, guideId: guide.id } });
    await transaction.guideChapter.delete({ where: { id: chapterId } });
    await transaction.guideRevision.create({
      data: { guideId: guide.id, actorId, actorSnapshot, summary: `删除章节：${chapter.title}`, snapshot: chapter as unknown as Prisma.InputJsonValue },
    });
    await writeAuditLog(transaction, { actorId, action: "GUIDE_CHAPTER_DELETE", targetType: "GUIDE_CHAPTER", targetId: chapterId, result: "SUCCESS", metadata: { city } });
  });
}

export async function attachGuideChapterImage(
  db: PrismaClient,
  city: City,
  chapterId: string,
  file: GuideImageInput,
  kind: "IMAGE" | "MAP",
  actorId: string,
  privateRoot = defaultPrivateRoot,
) {
  validateGuideImage(file);
  const extension = path.extname(file.fileName).toLowerCase();
  const storageKey = path.posix.join("assets", "guides", `${randomUUID()}${extension}`);
  const absolutePath = path.resolve(privateRoot, storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, file.bytes);
  try {
    return await db.$transaction(async (transaction) => {
      const actorSnapshot = await loadActorSnapshot(transaction, actorId);
      const guide = await transaction.cityGuide.findUniqueOrThrow({ where: { city } });
      const chapter = await transaction.guideChapter.findFirstOrThrow({ where: { id: chapterId, guideId: guide.id } });
      const asset = await transaction.fileAsset.create({
        data: {
          kind: kind === "MAP" ? FileAssetKind.GUIDE_MAP : FileAssetKind.GUIDE_IMAGE,
          storageKey,
          originalName: path.basename(file.fileName),
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          uploadedById: actorId,
          uploadedBySnapshot: actorSnapshot,
        },
      });
      await transaction.guideChapter.update({ where: { id: chapter.id }, data: { imageAssetId: asset.id } });
      await transaction.guideRevision.create({
        data: { guideId: guide.id, actorId, actorSnapshot, summary: `更新章节图片：${chapter.title}`, snapshot: { chapterId, previousAssetId: chapter.imageAssetId ?? null } },
      });
      await writeAuditLog(transaction, { actorId, action: "GUIDE_CHAPTER_IMAGE", targetType: "GUIDE_CHAPTER", targetId: chapterId, result: "SUCCESS", metadata: { city, kind } });
      return asset;
    });
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { City, FileAssetKind, Role } from "../src/generated/prisma/enums";
import { snapshotUserIdentity } from "../src/features/admin-accounts/identity-snapshot";
import { prisma } from "../src/lib/db/client";

const sources = [
  { city: City.SHANGHAI, folder: "shanghai", title: "上海入职指南" },
  { city: City.SHENZHEN, folder: "shenzhen", title: "深圳入职指南" },
  { city: City.CHANGSHA, folder: "changsha", title: "长沙入职指南" },
  { city: City.XIAN, folder: "xian", title: "西安入职指南" },
];

async function main() {
  const sourceRoot = path.resolve(
    process.env.GUIDE_RENDER_ROOT ?? "storage/private/guide-source-renders",
  );
  const assetRoot = path.resolve("storage/private/assets/guides");
  await mkdir(assetRoot, { recursive: true });
  const actor = await prisma.user.findFirst({
    where: { role: { in: [Role.SUPER_ADMIN, Role.ADMIN] } },
  });
  if (!actor) throw new Error("请先运行管理员初始化/种子脚本，再导入指南素材");

  for (const source of sources) {
    const guide = await prisma.cityGuide.upsert({
      where: { city: source.city },
      create: { city: source.city, title: source.title, summary: "来自现有入职指南源文件的 4 页内容" },
      update: { title: source.title },
    });
    for (let page = 1; page <= 4; page += 1) {
      const sourcePath = path.join(sourceRoot, source.folder, `page-${page}.png`);
      const sourceStats = await stat(sourcePath);
      const bytes = await readFile(sourcePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let asset = await prisma.fileAsset.findFirst({
        where: { kind: FileAssetKind.GUIDE_IMAGE, sha256 },
      });
      if (!asset) {
        const storageKey = path.posix.join("assets", "guides", `${randomUUID()}.png`);
        await copyFile(sourcePath, path.resolve("storage/private", storageKey));
        asset = await prisma.fileAsset.create({
          data: {
            kind: FileAssetKind.GUIDE_IMAGE,
            storageKey,
            originalName: `${source.folder}-page-${page}.png`,
            mimeType: "image/png",
            sizeBytes: sourceStats.size,
            sha256,
            uploadedById: actor.id,
            uploadedBySnapshot: snapshotUserIdentity(actor),
          },
        });
      }
      const existing = await prisma.guideChapter.findFirst({
        where: { guideId: guide.id, sortOrder: page },
      });
      const data = {
        title: `第 ${page} 页`,
        imageAssetId: asset.id,
        enabled: true,
      };
      if (existing) {
        await prisma.guideChapter.update({ where: { id: existing.id }, data });
      } else {
        await prisma.guideChapter.create({
          data: { guideId: guide.id, sortOrder: page, ...data },
        });
      }
    }
  }
  console.log("已导入 4 个城市、共 16 页指南素材。");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "指南素材导入失败");
    process.exitCode = 1;
  });

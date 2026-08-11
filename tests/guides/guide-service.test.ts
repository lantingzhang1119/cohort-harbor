import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { City, Role, UserSource, WorkLocation } from "@/generated/prisma/enums";
import {
  deleteGuideChapter,
  getGuideForEmployee,
  listGuideForAdmin,
  listGuidesForEmployee,
  reorderGuideChapters,
  upsertGuideChapter,
  updateGuide,
} from "@/features/guides/guide-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("guide service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminId: string;
  let employeeId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    adminId = (
      await testDb.db.user.create({ data: { employeeNo: "ADMIN-GUIDE", name: "指南管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })
    ).id;
    employeeId = (
      await testDb.db.user.create({ data: { employeeNo: "TEST-GUIDE", name: "指南员工", workLocation: WorkLocation.SHENZHEN, sourceType: UserSource.MANUAL, passwordHash } })
    ).id;
    for (const city of Object.values(City)) {
      await testDb.db.cityGuide.create({ data: { city, title: `${city} 入职指南` } });
    }
  });
  afterEach(async () => testDb.cleanup());

  it("recommends the employee city while keeping all four cities accessible", async () => {
    const guides = await listGuidesForEmployee(testDb.db, employeeId);
    expect(guides).toHaveLength(4);
    expect(guides[0]).toMatchObject({ city: City.SHENZHEN, recommended: true });
    expect(new Set(guides.map((guide) => guide.city))).toEqual(new Set(Object.values(City)));
  });

  it("returns ordered enabled chapters for any city", async () => {
    const guide = await testDb.db.cityGuide.findUniqueOrThrow({ where: { city: City.XIAN } });
    await testDb.db.guideChapter.createMany({ data: [
      { guideId: guide.id, title: "第二页", sortOrder: 2 },
      { guideId: guide.id, title: "第一页", sortOrder: 1 },
      { guideId: guide.id, title: "隐藏页", sortOrder: 3, enabled: false },
    ] });
    const result = await getGuideForEmployee(testDb.db, employeeId, City.XIAN);
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(["第一页", "第二页"]);
  });

  it("creates an administrator revision when guide content changes", async () => {
    await updateGuide(
      testDb.db,
      City.CHANGSHA,
      { title: "长沙入职指南（更新）", summary: "本地演示修订", enabled: true },
      adminId,
    );
    const updated = await testDb.db.cityGuide.findUniqueOrThrow({
      where: { city: City.CHANGSHA },
      include: { revisions: true },
    });
    expect(updated.title).toBe("长沙入职指南（更新）");
    expect(updated.revisions).toHaveLength(1);
    expect(updated.revisions[0]?.actorId).toBe(adminId);
  });

  it("lets administrators create, edit, order, disable and delete guide chapters with revisions", async () => {
    const first = await upsertGuideChapter(testDb.db, City.SHANGHAI, null, {
      title: "办公与交通",
      body: "虚构章节正文",
      address: "虚构地址",
      contact: "虚构联系人",
      externalUrl: "https://example.invalid/guide",
      sortOrder: 1,
      enabled: true,
    }, adminId);
    const second = await upsertGuideChapter(testDb.db, City.SHANGHAI, null, {
      title: "座位与设施",
      sortOrder: 2,
      enabled: true,
    }, adminId);
    await upsertGuideChapter(testDb.db, City.SHANGHAI, first.id, {
      title: "办公、交通与周边",
      body: "更新后的虚构正文",
      sortOrder: 1,
      enabled: false,
    }, adminId);
    await reorderGuideChapters(testDb.db, City.SHANGHAI, [second.id, first.id], adminId);

    const adminGuide = await listGuideForAdmin(testDb.db, City.SHANGHAI);
    expect(adminGuide.chapters.map((chapter) => [chapter.id, chapter.sortOrder, chapter.enabled])).toEqual([
      [second.id, 1, true],
      [first.id, 2, false],
    ]);
    await deleteGuideChapter(testDb.db, City.SHANGHAI, first.id, adminId);
    expect(await testDb.db.guideChapter.count({ where: { id: first.id } })).toBe(0);
    expect(await testDb.db.guideRevision.count({ where: { guideId: adminGuide.id } })).toBe(5);
  });
});

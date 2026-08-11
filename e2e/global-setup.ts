import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import type { FullConfig } from "@playwright/test";
import * as XLSX from "xlsx";

import { createTextPdf } from "../tests/fixtures/question-bank-import";

export async function seedE2eDatabase() {
  const projectRoot = process.cwd();
  const databasePath = path.join(projectRoot, "storage", "private", "e2e.db");
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await mkdir(path.dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  const migrationsRoot = path.join(projectRoot, "prisma", "migrations");
  for (const migration of (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    sqlite.exec(await readFile(path.join(migrationsRoot, migration, "migration.sql"), "utf8"));
  }
  sqlite.close();

  process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
  const [{ createPrismaClient }, { seedDatabase }, { hashPassword }, enums] = await Promise.all([
    import("../src/lib/db/create-client"),
    import("../scripts/seed"),
    import("../src/features/auth/password"),
    import("../src/generated/prisma/enums"),
  ]);
  const db = createPrismaClient(process.env.DATABASE_URL);
  const seeded = await seedDatabase(db, {
    adminUsername: "e2e-admin",
    adminDisplayName: "端到端管理员",
    adminPassword: "AdminE2EPass!23",
  });
  const seededAdmin = await db.user.findUniqueOrThrow({ where: { id: seeded.adminId } });
  const adminSnapshot = {
    id: seededAdmin.id,
    employeeNo: seededAdmin.employeeNo,
    name: seededAdmin.name,
    email: seededAdmin.email,
    role: seededAdmin.role,
  };
  const passwordHash = await hashPassword("DemoEmployeePass2026");
  const secureHash = await hashPassword("EmployeeSecure!23");
  const regularAdminHash = await hashPassword("RegularAdmin!23");
  await db.user.create({
    data: {
      employeeNo: "E2E-ADMIN",
      name: "端到端普通管理员",
      email: "regular-admin-e2e@example.invalid",
      role: enums.Role.ADMIN,
      sourceType: enums.UserSource.MANUAL,
      mustChangePassword: false,
      passwordHash: regularAdminHash,
    },
  });
  const employee = await db.user.create({
    data: {
      employeeNo: "E2E-EMP",
      name: "端到端员工",
      email: "employee-e2e@example.invalid",
      firstDepartment: "演示中心",
      position: "体验专员",
      workLocation: enums.WorkLocation.SHANGHAI,
      role: enums.Role.EMPLOYEE,
      sourceType: enums.UserSource.MANUAL,
      hiredAt: new Date("2026-07-01T00:00:00Z"),
      mustChangePassword: true,
      passwordHash,
    },
  });
  await db.user.create({
    data: {
      employeeNo: "E2E-SEC",
      name: "权限测试员工",
      email: "security-e2e@example.invalid",
      workLocation: enums.WorkLocation.SHENZHEN,
      role: enums.Role.EMPLOYEE,
      sourceType: enums.UserSource.MANUAL,
      hiredAt: new Date("2026-07-01T00:00:00Z"),
      mustChangePassword: false,
      passwordHash: secureHash,
    },
  });
  await db.user.createMany({
    data: [
      ["E2E-POLICY-SH", "制度验收上海员工", "policy-shanghai-e2e@example.invalid", enums.WorkLocation.SHANGHAI],
      ["E2E-POLICY-SZ", "制度验收深圳员工", "policy-shenzhen-e2e@example.invalid", enums.WorkLocation.SHENZHEN],
      ["E2E-POLICY-CS", "制度验收长沙员工", "policy-changsha-e2e@example.invalid", enums.WorkLocation.CHANGSHA],
      ["E2E-POLICY-XA", "制度验收西安员工", "policy-xian-e2e@example.invalid", enums.WorkLocation.XIAN],
    ].map(([employeeNo, name, email, workLocation]) => ({
      employeeNo: employeeNo as string,
      name: name as string,
      email: email as string,
      workLocation: workLocation as typeof enums.WorkLocation.SHANGHAI,
      role: enums.Role.EMPLOYEE,
      sourceType: enums.UserSource.MANUAL,
      hiredAt: new Date("2026-07-01T00:00:00Z"),
      mustChangePassword: false,
      passwordHash: secureHash,
    })),
  });
  const shanghaiCalendarDate = (offsetDays: number) => {
    const shifted = new Date(Date.now() + offsetDays * 86_400_000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(shifted);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  };
  await db.user.createMany({ data: [
    {
      employeeNo: "E2E-MAIL-TODAY", name: "今日入职员工", email: "today-mail-e2e@example.invalid",
      workLocation: enums.WorkLocation.SHANGHAI, role: enums.Role.EMPLOYEE, sourceType: enums.UserSource.MANUAL,
      hiredAt: new Date(`${shanghaiCalendarDate(0)}T04:00:00.000Z`), mustChangePassword: false, passwordHash,
    },
    {
      employeeNo: "E2E-MAIL-PAST", name: "历史漏发员工", email: "past-mail-e2e@example.invalid",
      workLocation: enums.WorkLocation.SHANGHAI, role: enums.Role.EMPLOYEE, sourceType: enums.UserSource.MANUAL,
      hiredAt: new Date(`${shanghaiCalendarDate(-1)}T04:00:00.000Z`), mustChangePassword: false, passwordHash,
    },
  ] });
  await db.examAssignment.create({
    data: { userId: employee.id, examId: seeded.examId, dueAt: new Date("2030-12-31T00:00:00Z") },
  });
  await db.notification.create({
    data: { userId: employee.id, type: enums.NotificationType.SYSTEM, title: "欢迎加入", body: "这是虚构的端到端测试通知。" },
  });

  const e2eAssetRoot = path.join(projectRoot, "storage", "private", "e2e-assets");
  process.env.PRIVATE_STORAGE_ROOT = e2eAssetRoot;
  await rm(e2eAssetRoot, { recursive: true, force: true });
  await mkdir(path.join(e2eAssetRoot, "guides"), { recursive: true });
  const guideSources = [
    { city: enums.City.SHANGHAI, folder: "shanghai" },
    { city: enums.City.SHENZHEN, folder: "shenzhen" },
    { city: enums.City.CHANGSHA, folder: "changsha" },
    { city: enums.City.XIAN, folder: "xian" },
  ];
  const syntheticGuidePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  for (const source of guideSources) {
    const destinationPath = path.join(e2eAssetRoot, "guides", `${source.folder}.png`);
    await writeFile(destinationPath, syntheticGuidePng);
    const bytes = await readFile(destinationPath);
    const stats = await stat(destinationPath);
    const asset = await db.fileAsset.create({
      data: {
        kind: enums.FileAssetKind.GUIDE_IMAGE,
        storageKey: path.relative(e2eAssetRoot, destinationPath).replaceAll("\\", "/"),
        originalName: `${source.folder}-page-1.png`,
        mimeType: "image/png",
        sizeBytes: stats.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        uploadedById: seeded.adminId,
        uploadedBySnapshot: adminSnapshot,
      },
    });
    const guide = await db.cityGuide.findUniqueOrThrow({ where: { city: source.city } });
    await db.guideChapter.create({ data: { guideId: guide.id, title: "第 1 页", sortOrder: 1, imageAssetId: asset.id } });
  }
  const policyPath = path.join(e2eAssetRoot, "test-policy.pdf");
  const policyBytes = Buffer.from(createTextPdf([
    "CohortHarbor employee learning policy",
    "This fictional document verifies private multi-city preview access.",
  ]));
  await writeFile(policyPath, policyBytes);
  const policyAsset = await db.fileAsset.create({
    data: {
      kind: enums.FileAssetKind.POLICY_PDF,
      storageKey: "test-policy.pdf",
      originalName: "fictional-policy.pdf",
      mimeType: "application/pdf",
      sizeBytes: policyBytes.length,
      sha256: createHash("sha256").update(policyBytes).digest("hex"),
      uploadedById: seeded.adminId,
      uploadedBySnapshot: adminSnapshot,
    },
  });
  const policy = await db.policy.create({
    data: { name: "虚构员工学习制度", category: "端到端测试", applicableCities: ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"], status: enums.PolicyStatus.PUBLISHED },
  });
  await db.policyVersion.create({
    data: {
      policyId: policy.id,
      versionNumber: "E2E-1.0",
      effectiveDate: new Date("2026-01-01T00:00:00Z"),
      fileAssetId: policyAsset.id,
      previewStatus: enums.PolicyPreviewStatus.READY,
      previewAssetId: policyAsset.id,
      previewFormat: "PDF",
      previewGeneratedAt: new Date(),
    },
  });

  const headers = ["工号", "姓名", "一级部门", "二级部门", "岗位", "人员状态", "入职日期", "离职日期", "邮箱"];
  const rows = [
    ["E2E-ROSTER", "名册虚构员工甲", "演示中心", "一部", "测试岗", "正式", "2026-07-01", "", "roster-a@example.invalid"],
    ["E2E-ROSTER", "名册虚构员工乙", "演示中心", "二部", "测试岗", "正式", "2026-07-02", "", "roster-b@example.invalid"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Sheet1");
  const e2eInputDirectory = path.join(projectRoot, "artifacts", "e2e-inputs");
  await mkdir(e2eInputDirectory, { recursive: true });
  const workbookBytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  await writeFile(path.join(e2eInputDirectory, "e2e-roster.xlsx"), workbookBytes);
  await db.$disconnect();
}

export default async function globalSetup(config: FullConfig) {
  void config;
  await seedE2eDatabase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedE2eDatabase().catch((error) => {
    console.error(error instanceof Error ? error.message : "E2E 数据初始化失败");
    process.exitCode = 1;
  });
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminOnboardingKitRoute } from "@/app/api/admin/onboarding-kit/route";
import { createAdminMaterialFileRoute } from "@/app/api/admin/onboarding-kit/[id]/file/route";
import { createAdminMaterialPublishRoute } from "@/app/api/admin/onboarding-kit/[id]/publish/route";
import { createAdminMaterialArchiveRoute } from "@/app/api/admin/onboarding-kit/[id]/archive/route";
import { createOnboardingKitRoute } from "@/app/api/onboarding-kit/route";
import { createOnboardingMaterialDownloadRoute } from "@/app/api/onboarding-kit/[id]/download/route";
import { createOnboardingKitZipRoute, onboardingZipRuntimeOptions } from "@/app/api/onboarding-kit/download-zip/route";
import { EmployeeModuleKey, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createMaterial, publishMaterial, replaceMaterialFile } from "@/features/onboarding-kit/material-service";
import type { UploadFileLike } from "@/features/onboarding-kit/file-types";
import { parseEnv } from "@/lib/env";
import { createTestDatabase } from "../helpers/test-db";

function upload(name: string, content: string): UploadFileLike {
  const bytes = Buffer.from(content);
  return { fileName: name, mimeType: "text/plain", size: bytes.byteLength, stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

describe("onboarding-kit admin and employee routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminId: string;
  let adminToken: string;
  let superToken: string;
  let employeeToken: string;
  let adminEmployeeToken: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-kit-routes-"));
    const passwordHash = await hashPassword("RoutesPass123");
    const admin = await testDb.db.user.create({ data: { employeeNo: "KIT-A", name: "管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const superAdmin = await testDb.db.user.create({ data: { employeeNo: "KIT-SA", name: "超级管理员", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const employee = await testDb.db.user.create({ data: { employeeNo: "KIT-E", name: "员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    adminId = admin.id;
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    superToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
    adminEmployeeToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
  });
  afterEach(async () => { await testDb.cleanup(); await rm(privateRoot, { recursive: true, force: true }); });

  const deps = () => ({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
  const request = (url: string, token: string, method = "GET", body?: BodyInit, origin: string | null = "http://localhost:3000") => new Request(`http://localhost:3000${url}`, {
    method, headers: { cookie: `cohort_harbor_session=${token}`, ...(origin === null ? {} : { origin }) }, body,
  });
  const form = (title: string, content = title) => { const data = new FormData(); data.set("title", title); data.set("category", "入职必读"); data.set("sortOrder", "0"); data.set("file", new File([content], `${title}.txt`, { type: "text/plain" })); return data; };

  it("gives admin and super-admin equal list/create access and enforces same origin", async () => {
    const route = createAdminOnboardingKitRoute(deps());
    expect((await route.GET(request("/api/admin/onboarding-kit", adminToken))).status).toBe(200);
    expect((await route.GET(request("/api/admin/onboarding-kit", superToken))).status).toBe(200);
    expect((await route.GET(request("/api/admin/onboarding-kit", employeeToken))).status).toBe(403);
    expect((await route.POST(request("/api/admin/onboarding-kit", adminToken, "POST", form("管理员资料"), null))).status).toBe(403);
    expect((await route.POST(request("/api/admin/onboarding-kit", superToken, "POST", form("超级管理员资料")))).status).toBe(201);
  });

  it("lists only published current versions to employee view and blocks module-off access", async () => {
    const draft = await createMaterial(adminId, { title: "草稿", category: "测试", sortOrder: 0 }, upload("draft.txt", "draft"), deps());
    const published = await createMaterial(adminId, { title: "已发布", category: "测试", sortOrder: 1 }, upload("published.txt", "published"), deps());
    await publishMaterial(adminId, published.id, deps());
    const route = createOnboardingKitRoute({ db: testDb.db });
    const response = await route.GET(request("/api/onboarding-kit", employeeToken));
    expect(response.status).toBe(200);
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("已发布");
    expect(payload).not.toContain("草稿");
    expect(payload).not.toContain("storageKey");
    expect((await route.GET(request("/api/onboarding-kit", adminToken))).status).toBe(403);
    expect((await route.GET(request("/api/onboarding-kit", adminEmployeeToken))).status).toBe(200);
    await testDb.db.employeeModuleSetting.update({ where: { key: EmployeeModuleKey.ONBOARDING_KIT }, data: { enabled: false } });
    expect((await route.GET(request("/api/onboarding-kit", employeeToken))).status).toBe(403);
    expect(draft.status).toBe("DRAFT");
  });

  it("serves historical versions only to admin and current published bytes only to employees", async () => {
    const material = await createMaterial(adminId, { title: "版本资料", category: "测试", sortOrder: 0 }, upload("v1.txt", "one"), deps());
    const v1 = material.currentVersion!;
    await publishMaterial(adminId, material.id, deps());
    await replaceMaterialFile(adminId, material.id, upload("v2.txt", "two"), deps());

    const adminFile = createAdminMaterialFileRoute(deps(), material.id);
    const historical = await adminFile.GET(request(`/api/admin/onboarding-kit/${material.id}/file?versionId=${v1.id}`, adminToken));
    expect(historical.status).toBe(200);
    expect(await historical.text()).toBe("one");
    expect(historical.headers.get("content-disposition")).toContain("filename*");
    expect((await adminFile.GET(request(`/api/admin/onboarding-kit/${material.id}/file?versionId=wrong`, adminToken))).status).toBe(404);

    const employeeFile = createOnboardingMaterialDownloadRoute({ db: testDb.db, privateRoot }, material.id);
    const current = await employeeFile(request(`/api/onboarding-kit/${material.id}/download`, employeeToken));
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("two");
    expect((await employeeFile(request(`/api/onboarding-kit/${material.id}/download`, adminToken))).status).toBe(403);

    const archive = createAdminMaterialArchiveRoute({ db: testDb.db }, material.id);
    expect((await archive(request(`/api/admin/onboarding-kit/${material.id}/archive`, adminToken, "POST", undefined, null))).status).toBe(403);
    expect((await archive(request(`/api/admin/onboarding-kit/${material.id}/archive`, adminToken, "POST"))).status).toBe(200);
    expect((await employeeFile(request(`/api/onboarding-kit/${material.id}/download`, employeeToken))).status).toBe(404);
  });

  it("audits an admin historical-version download without recording its private path", async () => {
    const material = await createMaterial(adminId, { title: "审计版本", category: "测试", sortOrder: 0 }, upload("v1.txt", "one"), deps());
    const v1 = material.currentVersion!;
    await publishMaterial(adminId, material.id, deps());
    await replaceMaterialFile(adminId, material.id, upload("v2.txt", "two"), deps());

    const response = await createAdminMaterialFileRoute(deps(), material.id).GET(request(`/api/admin/onboarding-kit/${material.id}/file?versionId=${v1.id}`, adminToken));

    expect(response.status).toBe(200);
    const audit = await testDb.db.auditLog.findFirstOrThrow({ where: { action: "ONBOARDING_MATERIAL_ADMIN_DOWNLOAD" } });
    expect(audit).toMatchObject({ targetId: material.id, metadata: { versionId: v1.id, versionNumber: 1, historical: true } });
    expect(JSON.stringify(audit)).not.toContain(privateRoot);
  });

  it("publishes through same-origin lifecycle mutation and rejects employee mode", async () => {
    const material = await createMaterial(adminId, { title: "生命周期", category: "测试", sortOrder: 0 }, upload("life.txt", "life"), deps());
    const publish = createAdminMaterialPublishRoute({ db: testDb.db }, material.id);
    expect((await publish(request(`/api/admin/onboarding-kit/${material.id}/publish`, adminEmployeeToken, "POST"))).status).toBe(403);
    expect((await publish(request(`/api/admin/onboarding-kit/${material.id}/publish`, adminToken, "POST", undefined, "https://attacker.invalid"))).status).toBe(403);
    expect((await publish(request(`/api/admin/onboarding-kit/${material.id}/publish`, superToken, "POST"))).status).toBe(200);
  });

  it("builds ZIP only for same-origin employee-view requests and deletes it after streaming", async () => {
    const material = await createMaterial(adminId, { title: "ZIP 路由", category: "测试", sortOrder: 0 }, upload("route.txt", "route-bytes"), deps());
    await publishMaterial(adminId, material.id, deps());
    const zipRoot = path.join(privateRoot, "zip-temp");
    const route = createOnboardingKitZipRoute({ db: testDb.db, privateRoot, zipRoot, maxItems: 10, maxTotalBytes: 1024 });
    const body = JSON.stringify({ materialIds: [material.id] });
    expect((await route(request("/api/onboarding-kit/download-zip", employeeToken, "POST", body, null))).status).toBe(403);
    expect((await route(request("/api/onboarding-kit/download-zip", adminToken, "POST", body))).status).toBe(403);
    const response = await route(request("/api/onboarding-kit/download-zip", employeeToken, "POST", body));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-length")).toMatch(/^\d+$/);
    expect(response.headers.get("content-disposition")).toContain("filename*");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await expect((await import("node:fs/promises")).readdir(zipRoot, { recursive: true }).then((entries) => entries.filter((entry) => String(entry).endsWith(".zip")))).resolves.toHaveLength(0);
  });

  it("converts validated ZIP environment values into runtime options", () => {
    const runtime = onboardingZipRuntimeOptions(parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      AUTH_TOKEN_SECRET: "test-only-auth-token-hmac-secret-2026",
      PRIVATE_STORAGE_ROOT: privateRoot,
      ONBOARDING_ZIP_TEMP_ROOT: path.join(privateRoot, "zip-env"),
      ONBOARDING_ZIP_MAX_FILES: "3",
      ONBOARDING_ZIP_MAX_MB: "7",
      ONBOARDING_ZIP_MAX_CONCURRENT: "1",
    }));
    expect(runtime).toEqual({
      zipRoot: path.join(privateRoot, "zip-env"),
      maxItems: 3,
      maxTotalBytes: 7 * 1024 * 1024,
      maxConcurrentBuilds: 1,
    });
  });

  it("rejects four IDs when the validated ZIP file cap is three", async () => {
    const runtime = onboardingZipRuntimeOptions(parseEnv({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "change-me-12345",
      AUTH_TOKEN_SECRET: "test-only-auth-token-hmac-secret-2026",
      ONBOARDING_ZIP_TEMP_ROOT: path.join(privateRoot, "zip-env-cap"),
      ONBOARDING_ZIP_MAX_FILES: "3",
    }));
    const route = createOnboardingKitZipRoute({ db: testDb.db, privateRoot, ...runtime });
    const response = await route(request(
      "/api/onboarding-kit/download-zip",
      employeeToken,
      "POST",
      JSON.stringify({ materialIds: ["one", "two", "three", "four"] }),
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "TOO_MANY_ITEMS" });
  });

  it("rejects and cleans a prepared ZIP when a selected material is archived before handoff", async () => {
    const material = await createMaterial(adminId, { title: "ZIP 竞态", category: "测试", sortOrder: 0 }, upload("race.txt", "race"), deps());
    await publishMaterial(adminId, material.id, deps());
    const zipRoot = path.join(privateRoot, "zip-race");
    const findMany = testDb.db.onboardingMaterial.findMany.bind(testDb.db.onboardingMaterial);
    let calls = 0;
    vi.spyOn(testDb.db.onboardingMaterial, "findMany").mockImplementation((async (...args: Parameters<typeof findMany>) => {
      const result = await findMany(...args);
      if (++calls === 1) await testDb.db.onboardingMaterial.update({ where: { id: material.id }, data: { status: "ARCHIVED" } });
      return result;
    }) as never);

    const response = await createOnboardingKitZipRoute({ db: testDb.db, privateRoot, zipRoot, maxItems: 10, maxTotalBytes: 1024 })(request("/api/onboarding-kit/download-zip", employeeToken, "POST", JSON.stringify({ materialIds: [material.id] })));

    expect(response.status).not.toBe(200);
    await expect((await import("node:fs/promises")).readdir(zipRoot, { recursive: true }).then((entries) => entries.filter((entry) => String(entry).endsWith(".zip")))).resolves.toHaveLength(0);
  });

  it("cleans a prepared ZIP if its audit write fails", async () => {
    const material = await createMaterial(adminId, { title: "ZIP 审计失败", category: "测试", sortOrder: 0 }, upload("audit.txt", "audit"), deps());
    await publishMaterial(adminId, material.id, deps());
    const zipRoot = path.join(privateRoot, "zip-audit-failure");
    vi.spyOn(testDb.db.auditLog, "create").mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await createOnboardingKitZipRoute({ db: testDb.db, privateRoot, zipRoot, maxItems: 10, maxTotalBytes: 1024 })(request("/api/onboarding-kit/download-zip", employeeToken, "POST", JSON.stringify({ materialIds: [material.id] })));

    expect(response.status).not.toBe(200);
    await expect((await import("node:fs/promises")).readdir(zipRoot, { recursive: true }).then((entries) => entries.filter((entry) => String(entry).endsWith(".zip")))).resolves.toHaveLength(0);
  });

  it("rejects a single-file response when its current version changes after response preparation", async () => {
    const material = await createMaterial(adminId, { title: "单文件竞态", category: "测试", sortOrder: 0 }, upload("v1.txt", "one"), deps());
    await publishMaterial(adminId, material.id, deps());
    const findFirst = testDb.db.onboardingMaterial.findFirst.bind(testDb.db.onboardingMaterial);
    let calls = 0;
    vi.spyOn(testDb.db.onboardingMaterial, "findFirst").mockImplementation((async (...args: Parameters<typeof findFirst>) => {
      const result = await findFirst(...args);
      if (++calls === 1) await replaceMaterialFile(adminId, material.id, upload("v2.txt", "two"), deps());
      return result;
    }) as never);

    const response = await createOnboardingMaterialDownloadRoute({ db: testDb.db, privateRoot }, material.id)(request(`/api/onboarding-kit/${material.id}/download`, employeeToken));

    expect(response.status).not.toBe(200);
  });
});

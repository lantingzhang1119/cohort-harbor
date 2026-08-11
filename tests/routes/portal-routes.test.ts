import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPortalAssetRoute } from "@/app/api/admin/portal/[city]/assets/route";
import { createPortalDraftRoute } from "@/app/api/admin/portal/[city]/draft/route";
import { createPortalPublishRoute } from "@/app/api/admin/portal/[city]/publish/route";
import { createPortalRestoreRoute } from "@/app/api/admin/portal/[city]/restore/route";
import { createEmployeePortalRoute } from "@/app/api/portal/[city]/route";
import { City, FileAssetKind, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { readBoundedJson } from "@/features/portal/portal-request-body";
import { portalSceneV1Schema } from "@/features/portal/portal-scene";
import { createTestDatabase } from "../helpers/test-db";
import { validPng } from "../fixtures/portal-images";

describe("portal routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let adminToken: string;
  let adminEmployeeToken: string;
  let employeeToken: string;
  let superAdminToken: string;
  let superEmployeeToken: string;
  let employeeAdminToken: string;
  let assetId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-portal-routes-"));
    const passwordHash = await hashPassword("PortalPass123");
    const admin = await testDb.db.user.create({ data: { employeeNo: "PORTAL-ROUTE-A", name: "管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const employee = await testDb.db.user.create({ data: { employeeNo: "PORTAL-ROUTE-E", name: "员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const superAdmin = await testDb.db.user.create({ data: { employeeNo: "PORTAL-ROUTE-SA", name: "超级管理员", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    await testDb.db.cityGuide.create({ data: { city: City.SHANGHAI, title: "上海入职指南", enabled: true } });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    adminEmployeeToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
    employeeToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
    superAdminToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    superEmployeeToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
    employeeAdminToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.ADMIN })).token;
    assetId = (await testDb.db.fileAsset.create({ data: {
      kind: FileAssetKind.PORTAL_IMAGE,
      storageKey: "portal/fixture.png",
      originalName: "fixture.png",
      mimeType: "image/png",
      sizeBytes: 9,
      sha256: "fixture",
      uploadedById: admin.id,
      uploadedBySnapshot: snapshotUserIdentity(admin),
      portalAssetMetadata: {
        create: {
          category: "IMAGE",
          width: 100,
          height: 100,
          frameCount: 1,
          decodedCostBytes: 40_000n,
          inspectionStatus: "VALID",
          inspectedAt: new Date(),
        },
      },
    } })).id;
  });
  afterEach(async () => { await testDb.cleanup(); await rm(privateRoot, { recursive: true, force: true }); });

  function jsonRequest(url: string, token: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
    return new Request(`http://localhost:3000${url}`, { method, headers: { cookie: `cohort_harbor_session=${token}`, origin, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  }
  const layout = (viewport: "DESKTOP" | "MOBILE", id: string) => ({ viewport, elements: [{ id, kind: "IMAGE", assetId, x: 0, y: 0, width: 240, height: 120, zIndex: 1, altText: id }] });
  const visualScene = (viewport: "DESKTOP" | "MOBILE", id: string) => ({
    sceneVersion: 1,
    viewport,
    requiresMobileReview: false,
    background: {
      assetId: null,
      fitMode: "COVER",
      positionX: 50,
      positionY: 50,
      backgroundColor: "#FFFFFF",
      locked: false,
    },
    elements: [{
      id,
      name: id,
      type: "IMAGE",
      assetId,
      altText: id,
      fitMode: "CONTAIN",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      hidden: false,
    }],
  });

  it("requires ADMIN mode for draft, upload, publish and restore routes", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.SHANGHAI);
    const assets = createPortalAssetRoute({ db: testDb.db, privateRoot }, City.SHANGHAI);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.SHANGHAI);
    const restore = createPortalRestoreRoute({ db: testDb.db }, City.SHANGHAI);
    expect((await draft.GET(jsonRequest("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP", employeeToken))).status).toBe(403);
    expect((await draft.PATCH(jsonRequest("/api/admin/portal/SHANGHAI/draft", adminEmployeeToken, "PATCH", layout("DESKTOP", "hero")))).status).toBe(403);
    expect((await assets.GET(jsonRequest("/api/admin/portal/SHANGHAI/assets", employeeToken))).status).toBe(403);
    expect((await publish(jsonRequest("/api/admin/portal/SHANGHAI/publish", adminEmployeeToken, "POST", {}))).status).toBe(403);
    expect((await restore(jsonRequest("/api/admin/portal/SHANGHAI/restore", employeeToken, "POST", { viewport: "DESKTOP" }))).status).toBe(403);
  });

  it("enforces the complete role by view-mode matrix", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.SHANGHAI);
    const employee = createEmployeePortalRoute({ db: testDb.db }, City.SHANGHAI);
    const sessions = [
      { token: superAdminToken, admin: 200, employee: 403 },
      { token: superEmployeeToken, admin: 403, employee: 200 },
      { token: adminToken, admin: 200, employee: 403 },
      { token: adminEmployeeToken, admin: 403, employee: 200 },
      { token: employeeAdminToken, admin: 403, employee: 403 },
      { token: employeeToken, admin: 403, employee: 200 },
    ];
    for (const entry of sessions) {
      expect((await draft.GET(jsonRequest("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP", entry.token))).status).toBe(entry.admin);
      expect((await employee(jsonRequest("/api/portal/SHANGHAI?viewport=DESKTOP", entry.token))).status).toBe(entry.employee);
    }
  });

  it("saves both drafts, publishes, and exposes only published layouts in EMPLOYEE mode", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.SHANGHAI);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.SHANGHAI);
    const employee = createEmployeePortalRoute({ db: testDb.db }, City.SHANGHAI);
    expect((await draft.PATCH(jsonRequest("/api/admin/portal/SHANGHAI/draft", adminToken, "PATCH", layout("DESKTOP", "desktop-v1")))).status).toBe(200);
    expect((await draft.PATCH(jsonRequest("/api/admin/portal/SHANGHAI/draft", adminToken, "PATCH", layout("MOBILE", "mobile-v1")))).status).toBe(200);

    const before = await employee(jsonRequest("/api/portal/SHANGHAI?viewport=DESKTOP", employeeToken));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ ok: true, portal: null });
    expect((await publish(jsonRequest("/api/admin/portal/SHANGHAI/publish", adminToken, "POST", {}))).status).toBe(201);

    await draft.PATCH(jsonRequest("/api/admin/portal/SHANGHAI/draft", adminToken, "PATCH", layout("DESKTOP", "draft-secret")));
    const response = await employee(jsonRequest("/api/portal/SHANGHAI?viewport=DESKTOP", employeeToken));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("desktop-v1");
    expect(text).not.toContain("draft-secret");
    expect(text).toContain(`/api/files/${assetId}`);
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("portal/fixture.png");
    expect(text).not.toContain("publishedBySnapshot");
    expect(text).not.toContain("publishedById");
    expect(JSON.parse(text).portal).toMatchObject({
      sceneVersion: 0,
      version: 1,
      viewport: "DESKTOP",
      elements: [{ id: "desktop-v1" }],
    });
    expect(JSON.parse(text).portal).not.toHaveProperty("scene");
    expect(JSON.parse(text).portal).not.toHaveProperty("createdAt");
    expect(JSON.parse(text).portal).not.toHaveProperty("city");
    expect((await employee(jsonRequest("/api/portal/SHANGHAI?viewport=DESKTOP", adminToken))).status).toBe(403);
  });

  it("returns a strict minimal V1 publication discriminator without legacy or internal fields", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.SHANGHAI);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.SHANGHAI);
    const employee = createEmployeePortalRoute({ db: testDb.db }, City.SHANGHAI);
    const desktopResponse = await draft.PATCH(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "PATCH",
      { viewport: "DESKTOP", revision: 0, scene: visualScene("DESKTOP", "desktop-v1") },
    ));
    const mobileResponse = await draft.PATCH(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "PATCH",
      { viewport: "MOBILE", revision: 0, scene: visualScene("MOBILE", "mobile-v1") },
    ));
    const desktopRevision = (await desktopResponse.json()).draft.revision as number;
    const mobileRevision = (await mobileResponse.json()).draft.revision as number;
    expect((await publish(jsonRequest(
      "/api/admin/portal/SHANGHAI/publish",
      adminToken,
      "POST",
      { desktopRevision, mobileRevision },
    ))).status).toBe(201);

    const response = await employee(jsonRequest(
      "/api/portal/SHANGHAI?viewport=MOBILE",
      employeeToken,
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      portal: {
        sceneVersion: 1,
        version: 1,
        scene: portalSceneV1Schema.parse(visualScene("MOBILE", "mobile-v1")),
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("publishedBy");
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain('"elements":[{"id":"mobile-v1","kind"');
  });

  it("rejects cross-origin saves and provides upload/delete behavior without leaking paths", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.XIAN);
    expect((await draft.PATCH(jsonRequest("/api/admin/portal/XIAN/draft", adminToken, "PATCH", layout("DESKTOP", "x"), "https://attacker.invalid"))).status).toBe(403);
    const assets = createPortalAssetRoute({ db: testDb.db, privateRoot }, City.XIAN);
    const form = new FormData();
    form.set("file", new File([validPng()], "logo.png", { type: "image/png" }));
    const upload = await assets.POST(new Request("http://localhost:3000/api/admin/portal/XIAN/assets", { method: "POST", headers: { cookie: `cohort_harbor_session=${adminToken}`, origin: "http://localhost:3000" }, body: form }));
    expect(upload.status).toBe(201);
    const uploadText = JSON.stringify(await upload.json());
    expect(uploadText).not.toContain(privateRoot);
    expect(uploadText).not.toContain("storageKey");
    const uploadedId = JSON.parse(uploadText).asset.id as string;
    expect((await assets.DELETE(jsonRequest(`/api/admin/portal/XIAN/assets?assetId=${uploadedId}`, adminToken, "DELETE"))).status).toBe(200);
  });

  it("returns actionable Chinese guidance for a structurally invalid portal image", async () => {
    const assets = createPortalAssetRoute({ db: testDb.db, privateRoot }, City.XIAN);
    const form = new FormData();
    form.set("file", new File([Buffer.concat([validPng(), Buffer.from("trailing")])], "broken.png", { type: "image/png" }));
    const response = await assets.POST(new Request("http://localhost:3000/api/admin/portal/XIAN/assets", {
      method: "POST", headers: { cookie: `cohort_harbor_session=${adminToken}`, origin: "http://localhost:3000" }, body: form,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "INVALID_STRUCTURE",
      message: "图片文件结构无效或不受支持，请重新导出为 PNG、JPG、WebP 或 GIF 后上传",
    });
  });

  it("bounds the multipart stream before buffering an oversized portal upload", async () => {
    const assets = createPortalAssetRoute({ db: testDb.db, privateRoot }, City.XIAN);
    const form = new FormData();
    form.set("file", new File(
      [new Uint8Array(11 * 1024 * 1024)],
      "oversized.png",
      { type: "image/png" },
    ));
    const before = await testDb.db.fileAsset.count();
    const response = await assets.POST(new Request("http://localhost:3000/api/admin/portal/XIAN/assets", {
      method: "POST",
      headers: {
        cookie: `cohort_harbor_session=${adminToken}`,
        origin: "http://localhost:3000",
      },
      body: form,
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(await testDb.db.fileAsset.count()).toBe(before);
  });

  it("rejects missing and malformed Origin on every mutation family", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.XIAN);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.XIAN);
    const restore = createPortalRestoreRoute({ db: testDb.db }, City.XIAN);
    const assets = createPortalAssetRoute({ db: testDb.db, privateRoot }, City.XIAN);
    const withoutOrigin = (url: string, method: string, body?: unknown) => new Request(`http://localhost:3000${url}`, {
      method,
      headers: { cookie: `cohort_harbor_session=${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect((await draft.PATCH(withoutOrigin("/api/admin/portal/XIAN/draft", "PATCH", layout("DESKTOP", "x")))).status).toBe(403);
    expect((await draft.POST(withoutOrigin("/api/admin/portal/XIAN/draft", "POST", { action: "COPY_DESKTOP_TO_MOBILE" }))).status).toBe(403);
    expect((await publish(withoutOrigin("/api/admin/portal/XIAN/publish", "POST", {}))).status).toBe(403);
    expect((await restore(withoutOrigin("/api/admin/portal/XIAN/restore", "POST", { viewport: "DESKTOP" }))).status).toBe(403);
    expect((await assets.DELETE(new Request("http://localhost:3000/api/admin/portal/XIAN/assets?assetId=x", { method: "DELETE", headers: { cookie: `cohort_harbor_session=${adminToken}`, origin: "::not-url::" } }))).status).toBe(403);
  });

  it("counts streamed JSON bytes without trusting Content-Length", async () => {
    const small = new Request("http://localhost:3000/api/admin/portal/XIAN/draft", {
      method: "PATCH",
      headers: { "content-length": "1" },
      body: JSON.stringify({ value: "ok" }),
    });
    await expect(readBoundedJson(small, 64)).resolves.toEqual({ value: "ok" });

    const oversized = new Request("http://localhost:3000/api/admin/portal/XIAN/draft", {
      method: "PATCH",
      body: JSON.stringify({ value: "x".repeat(100) }),
    });
    await expect(readBoundedJson(oversized, 32)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });

    const cancelFailure = new Request("http://localhost:3000/api/admin/portal/XIAN/draft", {
      method: "PATCH",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(33));
        },
        cancel() {
          throw new Error("injected cancel failure");
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedJson(cancelFailure, 32)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("returns 413 for an oversized streamed V1 draft body", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.XIAN);
    const body = JSON.stringify({ viewport: "DESKTOP", revision: 0, scene: { padding: "x".repeat(1024 * 1024) } });
    const response = await draft.PATCH(new Request("http://localhost:3000/api/admin/portal/XIAN/draft", {
      method: "PATCH",
      headers: {
        cookie: `cohort_harbor_session=${adminToken}`,
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "content-length": "1",
      },
      body,
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "BODY_TOO_LARGE" });
  });

  it("rejects a partial V1 copy request instead of downgrading to the legacy copy path", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.XIAN);
    expect((await draft.PATCH(jsonRequest(
      "/api/admin/portal/XIAN/draft",
      adminToken,
      "PATCH",
      layout("DESKTOP", "source"),
    ))).status).toBe(200);
    const response = await draft.POST(jsonRequest(
      "/api/admin/portal/XIAN/draft",
      adminToken,
      "POST",
      { action: "COPY_DESKTOP_TO_MOBILE", mobileRevision: 0 },
    ));
    expect(response.status).toBe(400);
    expect(await testDb.db.guidePortalDraft.findUnique({
      where: { city_viewport: { city: City.XIAN, viewport: "MOBILE" } },
    })).toBeNull();
  });

  it("does not let legacy save or publish payloads downgrade revisioned V1 drafts", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.XIAN);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.XIAN);
    const storedScene = (viewport: "DESKTOP" | "MOBILE") => ({
      sceneVersion: 1,
      viewport,
      requiresMobileReview: false,
      background: {
        assetId: null,
        fitMode: "COVER",
        positionX: 50,
        positionY: 50,
        backgroundColor: "#FFFFFF",
        locked: false,
      },
      elements: [],
    });
    for (const viewport of ["DESKTOP", "MOBILE"] as const) {
      await testDb.db.guidePortalDraft.create({ data: {
        city: City.XIAN,
        viewport,
        canvasWidth: viewport === "DESKTOP" ? 1440 : 390,
        canvasHeight: viewport === "DESKTOP" ? 900 : 844,
        elements: [],
        sceneVersion: 1,
        scene: storedScene(viewport),
        draftRevision: 3,
        updatedBySnapshot: {},
      } });
    }

    const saveResponse = await draft.PATCH(jsonRequest(
      "/api/admin/portal/XIAN/draft",
      adminToken,
      "PATCH",
      layout("DESKTOP", "legacy-overwrite"),
    ));
    expect(saveResponse.status).toBe(409);
    expect(await saveResponse.json()).toMatchObject({ code: "DRAFT_CONFLICT" });

    const publishResponse = await publish(jsonRequest(
      "/api/admin/portal/XIAN/publish",
      adminToken,
      "POST",
      {},
    ));
    expect(publishResponse.status).toBe(409);
    expect(await testDb.db.guidePortalPublication.count({ where: { city: City.XIAN } })).toBe(0);
    expect((await testDb.db.guidePortalDraft.findUniqueOrThrow({
      where: { city_viewport: { city: City.XIAN, viewport: "DESKTOP" } },
    })).sceneVersion).toBe(1);
  });

  it("keeps a copied mobile review gate through PATCH until the explicit review action", async () => {
    const draft = createPortalDraftRoute({ db: testDb.db }, City.SHANGHAI);
    const publish = createPortalPublishRoute({ db: testDb.db }, City.SHANGHAI);
    const desktopResponse = await draft.PATCH(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "PATCH",
      { viewport: "DESKTOP", revision: 0, scene: visualScene("DESKTOP", "desktop") },
    ));
    const desktop = (await desktopResponse.json()).draft;
    const copyResponse = await draft.POST(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "POST",
      {
        action: "COPY_DESKTOP_TO_MOBILE",
        desktopRevision: desktop.revision,
        mobileRevision: 0,
      },
    ));
    const copied = (await copyResponse.json()).draft;

    const saveResponse = await draft.PATCH(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "PATCH",
      {
        viewport: "MOBILE",
        revision: copied.revision,
        scene: { ...copied.scene, requiresMobileReview: false },
      },
    ));
    const saved = (await saveResponse.json()).draft;
    expect(saved.scene.requiresMobileReview).toBe(true);
    const blocked = await publish(jsonRequest(
      "/api/admin/portal/SHANGHAI/publish",
      adminToken,
      "POST",
      { desktopRevision: desktop.revision, mobileRevision: saved.revision },
    ));
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ code: "MOBILE_REVIEW_REQUIRED" });

    const confirmResponse = await draft.POST(jsonRequest(
      "/api/admin/portal/SHANGHAI/draft",
      adminToken,
      "POST",
      { action: "CONFIRM_MOBILE_REVIEW", revision: saved.revision },
    ));
    const confirmed = (await confirmResponse.json()).draft;
    expect((await publish(jsonRequest(
      "/api/admin/portal/SHANGHAI/publish",
      adminToken,
      "POST",
      { desktopRevision: desktop.revision, mobileRevision: confirmed.revision },
    ))).status).toBe(201);
    expect(await testDb.db.auditLog.count({
      where: { action: "PORTAL_MOBILE_REVIEW_CONFIRM" },
    })).toBe(1);
  });
});

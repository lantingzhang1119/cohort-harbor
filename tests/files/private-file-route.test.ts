import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { City, EmployeeModuleKey, FileAssetKind, PolicyStatus, PortalViewport, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { createPrivateFileRoute } from "@/app/api/files/[assetId]/route";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("private file route", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let token: string;
  let assetId: string;
  let adminToken: string;
  let adminEmployeeToken: string;
  let superAdminToken: string;
  let employeeAdminModeToken: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-files-"));
    const user = await testDb.db.user.create({ data: { employeeNo: "TEST-FILE", name: "文件员工", role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash: await hashPassword("InitialPass!23") } });
    token = (await createSession(testDb.db, user.id)).token;
    const admin = await testDb.db.user.create({ data: { employeeNo: "TEST-FILE-ADMIN", name: "文件管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash: await hashPassword("InitialPass!23") } });
    const superAdmin = await testDb.db.user.create({ data: { employeeNo: "TEST-FILE-SUPER", name: "文件超级管理员", role: Role.SUPER_ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash: await hashPassword("InitialPass!23") } });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    adminEmployeeToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
    superAdminToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeAdminModeToken = (await createSession(testDb.db, user.id, { viewMode: SessionViewMode.ADMIN })).token;
    await writeFile(path.join(privateRoot, "safe-image.png"), Buffer.from("fictional-image"));
    assetId = (
      await testDb.db.fileAsset.create({
        data: {
          kind: FileAssetKind.GUIDE_IMAGE,
          storageKey: "safe-image.png",
          originalName: "guide.png",
          mimeType: "image/png",
          sizeBytes: 17,
          sha256: "test-sha",
          uploadedById: user.id,
          uploadedBySnapshot: snapshotUserIdentity(user),
        },
      })
    ).id;
    for (const city of Object.values(City)) {
      await testDb.db.cityGuide.create({
        data: { city, title: `${city} 入职指南`, enabled: true },
      });
    }
    const guide = await testDb.db.cityGuide.findUniqueOrThrow({ where: { city: City.SHANGHAI } });
    await testDb.db.guideChapter.create({
      data: { guideId: guide.id, title: "员工可见章节", enabled: true, imageAssetId: assetId },
    });
  });
  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  function request(authenticated: boolean) {
    return new Request(`http://localhost:3000/api/files/${assetId}`, {
      headers: authenticated ? { cookie: `cohort_harbor_session=${token}` } : {},
    });
  }

  it("streams an authorized private asset without exposing its path", async () => {
    const route = createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId);
    const response = await route(request(true));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("fictional-image");
    expect(response.headers.get("x-storage-path")).toBeNull();
  });

  it("denies unauthenticated access and rejects traversal storage keys", async () => {
    const route = createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId);
    expect((await route(request(false))).status).toBe(401);
    await testDb.db.fileAsset.update({ where: { id: assetId }, data: { storageKey: "../secret.png" } });
    expect((await route(request(true))).status).toBe(404);
  });

  it("fails closed for new private kinds and when the owning employee module is disabled", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    async function asset(kind: FileAssetKind, name: string) {
      await writeFile(path.join(privateRoot, name), Buffer.from(name));
      return testDb.db.fileAsset.create({ data: {
        kind,
        storageKey: name,
        originalName: name,
        mimeType: "application/octet-stream",
        sizeBytes: name.length,
        sha256: name,
        uploadedById: uploader.id,
        uploadedBySnapshot: snapshotUserIdentity(uploader),
      } });
    }
    const material = await asset(FileAssetKind.ONBOARDING_MATERIAL, "material.bin");
    const mail = await asset(FileAssetKind.ONBOARDING_EMAIL_ASSET, "mail.bin");
    const status = (id: string) => createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(
      new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie: `cohort_harbor_session=${token}` } }),
    ).then((response) => response.status);

    expect(await status(material.id)).toBe(404);
    expect(await status(mail.id)).toBe(404);
    await testDb.db.employeeModuleSetting.update({
      where: { key: EmployeeModuleKey.GUIDES },
      data: { enabled: false },
    });
    expect(await status(assetId)).toBe(403);
    expect(await createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId)(
      new Request(`http://localhost:3000/api/files/${assetId}`, { headers: { cookie: `cohort_harbor_session=${adminEmployeeToken}` } }),
    ).then((response) => response.status)).toBe(403);
  });

  it("returns 404 for orphaned, disabled and superseded legacy assets", async () => {
    const chapter = await testDb.db.guideChapter.findFirstOrThrow({ where: { imageAssetId: assetId } });
    await testDb.db.guideChapter.update({ where: { id: chapter.id }, data: { enabled: false } });
    expect((await createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId)(request(true))).status).toBe(404);
    await testDb.db.guideChapter.update({ where: { id: chapter.id }, data: { enabled: true, imageAssetId: null } });
    expect((await createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId)(request(true))).status).toBe(404);
  });

  it("rejects storage paths whose intermediate component is a symlink outside the private root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "cohort-harbor-files-outside-"));
    try {
      await writeFile(path.join(outside, "secret.png"), "outside-secret");
      await mkdir(path.join(privateRoot, "portal"), { recursive: true });
      await symlink(outside, path.join(privateRoot, "portal", "escape"));
      await testDb.db.fileAsset.update({ where: { id: assetId }, data: { storageKey: "portal/escape/secret.png" } });
      const route = createPrivateFileRoute({ db: testDb.db, privateRoot }, assetId);
      expect((await route(request(true))).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows EMPLOYEE view to read only published portal assets while ADMIN view can preview", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    async function portalAsset(name: string) {
      await writeFile(path.join(privateRoot, `${name}.png`), Buffer.from(name));
      return testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.PORTAL_IMAGE, storageKey: `${name}.png`, originalName: `${name}.png`, mimeType: "image/png",
        sizeBytes: name.length, sha256: name, uploadedById: uploader.id, uploadedBySnapshot: snapshotUserIdentity(uploader),
      } });
    }
    const orphan = await portalAsset("orphan");
    const draftOnly = await portalAsset("draft-only");
    const published = await portalAsset("published");
    const latest = await portalAsset("latest");
    const otherCity = await portalAsset("other-city");
    const otherCityDesktop = await portalAsset("other-city-desktop");
    const element = (asset: string) => [{ id: asset, kind: "IMAGE", assetId: asset, x: 0, y: 0, width: 24, height: 24, zIndex: 0, altText: asset }];
    await testDb.db.guidePortalDraft.create({ data: { city: City.SHANGHAI, viewport: PortalViewport.DESKTOP, canvasWidth: 1440, canvasHeight: 900, elements: element(draftOnly.id), updatedById: uploader.id, updatedBySnapshot: snapshotUserIdentity(uploader) } });
    const oldPublication = await testDb.db.guidePortalPublication.create({ data: { city: City.SHANGHAI, viewport: PortalViewport.DESKTOP, version: 1, canvasWidth: 1440, canvasHeight: 900, elements: element(published.id), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
    const latestPublication = await testDb.db.guidePortalPublication.create({ data: { city: City.SHANGHAI, viewport: PortalViewport.DESKTOP, version: 2, canvasWidth: 1440, canvasHeight: 900, elements: element(latest.id), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
    const otherCityPublication = await testDb.db.guidePortalPublication.create({ data: { city: City.SHENZHEN, viewport: PortalViewport.MOBILE, version: 1, canvasWidth: 390, canvasHeight: 844, elements: element(otherCity.id), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
    const otherCityDesktopPublication = await testDb.db.guidePortalPublication.create({ data: { city: City.SHENZHEN, viewport: PortalViewport.DESKTOP, version: 1, canvasWidth: 1440, canvasHeight: 900, elements: element(otherCityDesktop.id), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
    await testDb.db.guidePortalAssetReference.createMany({ data: [
      { assetId: published.id, publicationId: oldPublication.id, elementId: published.id },
      { assetId: latest.id, publicationId: latestPublication.id, elementId: latest.id },
      { assetId: otherCity.id, publicationId: otherCityPublication.id, elementId: otherCity.id },
      { assetId: otherCityDesktop.id, publicationId: otherCityDesktopPublication.id, elementId: otherCityDesktop.id },
    ] });

    const status = async (id: string, sessionToken?: string) => createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(
      new Request(`http://localhost:3000/api/files/${id}`, { headers: sessionToken ? { cookie: `cohort_harbor_session=${sessionToken}` } : {} }),
    ).then((response) => response.status);

    for (const employeeView of [token, adminEmployeeToken]) {
      expect(await status(orphan.id, employeeView)).toBe(404);
      expect(await status(draftOnly.id, employeeView)).toBe(404);
      expect(await status(published.id, employeeView)).toBe(404);
      expect(await status(latest.id, employeeView)).toBe(200);
      expect(await status(otherCity.id, employeeView)).toBe(200);
      expect(await status(otherCityDesktop.id, employeeView)).toBe(200);
    }
    for (const adminView of [adminToken, superAdminToken]) {
      expect(await status(orphan.id, adminView)).toBe(200);
      expect(await status(draftOnly.id, adminView)).toBe(200);
      expect(await status(published.id, adminView)).toBe(200);
      expect(await status(latest.id, adminView)).toBe(200);
      expect(await status(otherCity.id, adminView)).toBe(200);
      expect(await status(otherCityDesktop.id, adminView)).toBe(200);
    }
    expect(await status(latest.id, employeeAdminModeToken)).toBe(403);
    expect(await status(latest.id)).toBe(401);
  });

  it("bounds the published-asset lookup to the latest publication per context regardless of history depth", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    async function portalAsset(name: string) {
      await writeFile(path.join(privateRoot, `${name}.png`), Buffer.from(name));
      return testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.PORTAL_IMAGE, storageKey: `${name}.png`, originalName: `${name}.png`, mimeType: "image/png",
        sizeBytes: name.length, sha256: name, uploadedById: uploader.id, uploadedBySnapshot: snapshotUserIdentity(uploader),
      } });
    }
    const stale = await portalAsset("stale-old-version");
    const current = await portalAsset("current-latest");
    const element = (asset: string) => [{ id: asset, kind: "IMAGE", assetId: asset, x: 0, y: 0, width: 24, height: 24, zIndex: 0, altText: asset }];
    // Deep history: 30 superseded versions in one city, plus a distinct latest version.
    let stalePublicationId = "";
    for (let version = 1; version <= 30; version += 1) {
      const publication = await testDb.db.guidePortalPublication.create({ data: { city: City.XIAN, viewport: PortalViewport.DESKTOP, version, canvasWidth: 1440, canvasHeight: 900, elements: element(version === 5 ? stale.id : `filler-${version}`), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
      if (version === 5) stalePublicationId = publication.id;
    }
    const currentPublication = await testDb.db.guidePortalPublication.create({ data: { city: City.XIAN, viewport: PortalViewport.DESKTOP, version: 31, canvasWidth: 1440, canvasHeight: 900, elements: element(current.id), publishedById: uploader.id, publishedBySnapshot: snapshotUserIdentity(uploader) } });
    await testDb.db.guidePortalAssetReference.createMany({ data: [
      { assetId: stale.id, publicationId: stalePublicationId, elementId: stale.id },
      { assetId: current.id, publicationId: currentPublication.id, elementId: current.id },
    ] });

    let rawQueryCalls = 0;
    let findManyCalls = 0;
    let findFirstCalls = 0;
    const originalRawQuery = testDb.db.$queryRaw.bind(testDb.db);
    const originalFindMany = testDb.db.guidePortalPublication.findMany.bind(testDb.db.guidePortalPublication);
    const originalFindFirst = testDb.db.guidePortalPublication.findFirst.bind(testDb.db.guidePortalPublication);
    testDb.db.$queryRaw = ((...args: Parameters<typeof originalRawQuery>) => {
      rawQueryCalls += 1;
      return originalRawQuery(...args);
    }) as typeof testDb.db.$queryRaw;
    testDb.db.guidePortalPublication.findMany = ((args: Parameters<typeof originalFindMany>[0]) => { findManyCalls += 1; return originalFindMany(args); }) as typeof originalFindMany;
    testDb.db.guidePortalPublication.findFirst = ((args: Parameters<typeof originalFindFirst>[0]) => { findFirstCalls += 1; return originalFindFirst(args); }) as typeof originalFindFirst;
    try {
      const status = (id: string) => createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(
        new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie: `cohort_harbor_session=${token}` } }),
      ).then((response) => response.status);
      expect(await status(current.id)).toBe(200);
      expect(await status(stale.id)).toBe(404);
    } finally {
      testDb.db.$queryRaw = originalRawQuery as typeof testDb.db.$queryRaw;
      testDb.db.guidePortalPublication.findMany = originalFindMany;
      testDb.db.guidePortalPublication.findFirst = originalFindFirst;
    }
    // Each authorization is one snapshot-consistent SQL statement over enabled cities,
    // latest publications and authoritative reference rows.
    expect(rawQueryCalls).toBe(2);
    expect(findManyCalls).toBe(0);
    expect(findFirstCalls).toBe(0);
  });

  it("authorizes a latest V1 background only through publication references", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    async function portalAsset(name: string) {
      await writeFile(path.join(privateRoot, `${name}.png`), Buffer.from(name));
      return testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: `${name}.png`,
        originalName: `${name}.png`,
        mimeType: "image/png",
        sizeBytes: name.length,
        sha256: name,
        uploadedById: uploader.id,
        uploadedBySnapshot: snapshotUserIdentity(uploader),
      } });
    }
    const stale = await portalAsset("v1-stale-background");
    const current = await portalAsset("v1-current-background");
    const oldPublication = await testDb.db.guidePortalPublication.create({ data: {
      city: City.CHANGSHA,
      viewport: PortalViewport.DESKTOP,
      version: 1,
      canvasWidth: 1440,
      canvasHeight: 900,
      elements: [],
      sceneVersion: 1,
      scene: { sceneVersion: 1, viewport: "DESKTOP", requiresMobileReview: false, background: { assetId: stale.id, fitMode: "COVER", positionX: 50, positionY: 50, backgroundColor: "#FFFFFF", locked: false }, elements: [] },
      publishedById: uploader.id,
      publishedBySnapshot: snapshotUserIdentity(uploader),
    } });
    const currentPublication = await testDb.db.guidePortalPublication.create({ data: {
      city: City.CHANGSHA,
      viewport: PortalViewport.DESKTOP,
      version: 2,
      canvasWidth: 1440,
      canvasHeight: 900,
      elements: [],
      sceneVersion: 1,
      scene: { sceneVersion: 1, viewport: "DESKTOP", requiresMobileReview: false, background: { assetId: current.id, fitMode: "COVER", positionX: 50, positionY: 50, backgroundColor: "#FFFFFF", locked: false }, elements: [] },
      publishedById: uploader.id,
      publishedBySnapshot: snapshotUserIdentity(uploader),
    } });
    await testDb.db.guidePortalAssetReference.createMany({ data: [
      { assetId: stale.id, publicationId: oldPublication.id, elementId: "__background__" },
      { assetId: current.id, publicationId: currentPublication.id, elementId: "__background__" },
    ] });

    const status = (id: string) => createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(
      new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie: `cohort_harbor_session=${token}` } }),
    ).then((response) => response.status);
    expect(await status(current.id)).toBe(200);
    expect(await status(stale.id)).toBe(404);
  });

  it("fails closed when a latest publication has partial or completely missing references", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    async function portalAsset(name: string) {
      await writeFile(path.join(privateRoot, `${name}.png`), Buffer.from(name));
      return testDb.db.fileAsset.create({ data: {
        kind: FileAssetKind.PORTAL_IMAGE,
        storageKey: `${name}.png`,
        originalName: `${name}.png`,
        mimeType: "image/png",
        sizeBytes: name.length,
        sha256: name,
        uploadedById: uploader.id,
        uploadedBySnapshot: snapshotUserIdentity(uploader),
      } });
    }
    const referenced = await portalAsset("legacy-referenced");
    const omitted = await portalAsset("legacy-reference-omitted");
    const element = (asset: string, zIndex: number) => ({
      id: asset,
      kind: "IMAGE" as const,
      assetId: asset,
      x: 0,
      y: 0,
      width: 24,
      height: 24,
      zIndex,
      altText: asset,
    });
    const publication = await testDb.db.guidePortalPublication.create({ data: {
      city: City.SHANGHAI,
      viewport: PortalViewport.MOBILE,
      version: 99,
      canvasWidth: 390,
      canvasHeight: 844,
      elements: [element(referenced.id, 0), element(omitted.id, 1)],
      publishedById: uploader.id,
      publishedBySnapshot: snapshotUserIdentity(uploader),
    } });
    await testDb.db.guidePortalAssetReference.create({
      data: {
        assetId: referenced.id,
        publicationId: publication.id,
        elementId: referenced.id,
      },
    });

    const status = (id: string) => createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(
      new Request(`http://localhost:3000/api/files/${id}`, {
        headers: { cookie: `cohort_harbor_session=${token}` },
      }),
    ).then((response) => response.status);
    expect(await status(referenced.id)).toBe(200);
    expect(await status(omitted.id)).toBe(404);
    await testDb.db.guidePortalAssetReference.deleteMany({
      where: { publicationId: publication.id },
    });
    expect(await status(referenced.id)).toBe(404);
    expect(await status(omitted.id)).toBe(404);
  });

  it("keeps guides available but denies direct policy originals in every view mode", async () => {
    const uploader = await testDb.db.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    await writeFile(path.join(privateRoot, "policy.pdf"), Buffer.from("policy"));
    const policy = await testDb.db.fileAsset.create({ data: { kind: FileAssetKind.POLICY_PDF, storageKey: "policy.pdf", originalName: "policy.pdf", mimeType: "application/pdf", sizeBytes: 6, sha256: "policy", uploadedById: uploader.id, uploadedBySnapshot: snapshotUserIdentity(uploader) } });
    const policyRecord = await testDb.db.policy.create({ data: {
      name: "员工可见制度",
      category: "测试",
      applicableCities: Object.values(City),
      status: PolicyStatus.PUBLISHED,
    } });
    await testDb.db.policyVersion.create({ data: {
      policyId: policyRecord.id,
      versionNumber: "1.0",
      effectiveDate: new Date("2026-01-01T00:00:00Z"),
      fileAssetId: policy.id,
    } });
    for (const [id, sessionToken, expected] of [[assetId, token, 200], [assetId, adminToken, 200], [policy.id, token, 404], [policy.id, adminToken, 404]] as const) {
      const response = await createPrivateFileRoute({ db: testDb.db, privateRoot }, id)(new Request(`http://localhost:3000/api/files/${id}`, { headers: { cookie: `cohort_harbor_session=${sessionToken}` } }));
      expect(response.status).toBe(expected);
    }
  });
});

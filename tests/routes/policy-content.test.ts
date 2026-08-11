import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { City, PolicyStatus, Role, UserSource } from "@/generated/prisma/enums";
import { createPolicyContentRoute } from "@/app/api/policies/[id]/content/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createPolicy, setPolicyStatus } from "@/features/policies/policy-service";
import { createTestDatabase } from "../helpers/test-db";

describe("policy content route", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  let token: string;
  let employeeId: string;
  let policyId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-content-"));
    const passwordHash = await hashPassword("InitialPass!23");
    const admin = await testDb.db.user.create({ data: { employeeNo: "ADMIN-CONTENT", name: "制度管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const employee = await testDb.db.user.create({ data: { employeeNo: "TEST-CONTENT", name: "阅读员工", sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    employeeId = employee.id;
    token = (await createSession(testDb.db, employee.id)).token;
    const policy = await createPolicy(testDb.db, { name: "阅读测试制度", category: "测试", applicableCities: [City.SHANGHAI], versionNumber: "1.0", effectiveDate: new Date(), file: { fileName: "policy.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7\nfictional-content\n%%EOF") }, actorId: admin.id, privateRoot });
    policyId = policy.id;
    await setPolicyStatus(testDb.db, policy.id, PolicyStatus.PUBLISHED, admin.id);
  });
  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  it("supports private byte ranges and creates a view log", async () => {
    const version = await testDb.db.policyVersion.findFirstOrThrow({ where: { policyId }, include: { fileAsset: true, previewAsset: true } });
    expect(version.previewAssetId).not.toBe(version.fileAssetId);
    await writeFile(path.join(privateRoot, version.fileAsset.storageKey), "mutated original must never be served");
    const route = createPolicyContentRoute({ db: testDb.db, privateRoot }, policyId);
    const response = await route(new Request(`http://localhost:3000/api/policies/${policyId}/content`, { headers: { cookie: `cohort_harbor_session=${token}`, range: "bytes=0-7" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toMatch(/^bytes 0-7\//);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("%PDF-1.7");
    expect(await testDb.db.policyViewLog.count()).toBe(1);
  });

  it("denies unauthenticated access", async () => {
    const route = createPolicyContentRoute({ db: testDb.db, privateRoot }, policyId);
    const response = await route(new Request(`http://localhost:3000/api/policies/${policyId}/content`));
    expect(response.status).toBe(401);
  });

  it("denies disabled employees and hides recycled policies", async () => {
    const route = createPolicyContentRoute({ db: testDb.db, privateRoot }, policyId);
    await testDb.db.user.update({ where: { id: employeeId }, data: { enabled: false } });
    expect((await route(new Request(`http://localhost:3000/api/policies/${policyId}/content`, { headers: { cookie: `cohort_harbor_session=${token}` } }))).status).toBe(401);

    await testDb.db.user.update({ where: { id: employeeId }, data: { enabled: true } });
    await testDb.db.policy.update({ where: { id: policyId }, data: { deletedAt: new Date(), statusBeforeDelete: PolicyStatus.PUBLISHED, status: PolicyStatus.ARCHIVED } });
    expect((await route(new Request(`http://localhost:3000/api/policies/${policyId}/content`, { headers: { cookie: `cohort_harbor_session=${token}` } }))).status).toBe(404);
  });
});

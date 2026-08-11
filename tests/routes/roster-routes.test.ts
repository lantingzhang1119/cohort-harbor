import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictResolution, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { createRosterCommitRoute } from "@/app/api/admin/roster/commit/route";
import { createRosterPreviewRoute } from "@/app/api/admin/roster/preview/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createRosterWorkbook } from "../fixtures/create-roster-workbook";
import { createTestDatabase } from "../helpers/test-db";

describe("roster routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminToken: string;
  let employeeToken: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    const admin = await testDb.db.user.create({ data: { employeeNo: "ADMIN-ROSTER", name: "名册管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    const employee = await testDb.db.user.create({ data: { employeeNo: "TEST-ROSTER", name: "名册员工", sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash } });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id)).token;
  });
  afterEach(async () => testDb.cleanup());

  function uploadRequest(token: string) {
    const form = new FormData();
    form.set(
      "file",
      new File([createRosterWorkbook({ bookType: "xlsx" })], "fictional.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    return new Request("http://localhost:3000/api/admin/roster/preview", {
      method: "POST",
      headers: { cookie: `cohort_harbor_session=${token}`, origin: "http://localhost:3000" },
      body: form,
    });
  }

  it("previews and commits a synthetic workbook without storing its bytes", async () => {
    const preview = createRosterPreviewRoute({ db: testDb.db });
    const previewResponse = await preview(uploadRequest(adminToken));
    expect(previewResponse.status).toBe(201);
    const previewBody = (await previewResponse.json()) as {
      ok: boolean;
      batchId: string;
      conflicts: Array<{ id: string }>;
    };
    expect(previewBody.ok).toBe(true);

    const commit = createRosterCommitRoute({ db: testDb.db });
    const response = await commit(
      new Request("http://localhost:3000/api/admin/roster/commit", {
        method: "POST",
        headers: {
          cookie: `cohort_harbor_session=${adminToken}`,
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          batchId: previewBody.batchId,
          decisions: previewBody.conflicts.map((conflict) => ({
            conflictId: conflict.id,
            resolution: ConflictResolution.KEEP_LAST,
          })),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await testDb.db.user.count({ where: { employeeNo: { startsWith: "TEST-00" } } })).toBe(2);
    const stored = await testDb.db.rosterImportBatch.findUniqueOrThrow({ where: { id: previewBody.batchId } });
    expect(JSON.stringify(stored.previewPayload)).not.toContain("UEsDB");
  });

  it("denies employee preview and commit routes", async () => {
    const preview = createRosterPreviewRoute({ db: testDb.db });
    expect((await preview(uploadRequest(employeeToken))).status).toBe(403);
    const commit = createRosterCommitRoute({ db: testDb.db });
    const response = await commit(
      new Request("http://localhost:3000/api/admin/roster/commit", {
        method: "POST",
        headers: { cookie: `cohort_harbor_session=${employeeToken}`, origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ batchId: "missing", decisions: [] }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it.each(["1234567890", "abcdefghij"])(
    "rejects a roster commit temporary password without both letters and digits: %s",
    async (temporaryPassword) => {
      const commit = createRosterCommitRoute({ db: testDb.db });
      const response = await commit(
        new Request("http://localhost:3000/api/admin/roster/commit", {
          method: "POST",
          headers: {
            cookie: `cohort_harbor_session=${adminToken}`,
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({ batchId: "missing", decisions: [], temporaryPassword }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        message: "导入提交参数无效",
      });
    },
  );

  it("accepts a policy-compliant roster temporary password into the existing business path", async () => {
    const commit = createRosterCommitRoute({ db: testDb.db });
    const response = await commit(
      new Request("http://localhost:3000/api/admin/roster/commit", {
        method: "POST",
        headers: {
          cookie: `cohort_harbor_session=${adminToken}`,
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          batchId: "missing",
          decisions: [],
          temporaryPassword: "Onboard123",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});

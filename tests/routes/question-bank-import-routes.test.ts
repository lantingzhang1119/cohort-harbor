import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Role,
  SessionViewMode,
  UserSource,
} from "@/generated/prisma/enums";
import { createAdminQuestionBankImportRoute } from "@/app/api/admin/question-banks/import/route";
import { createAdminQuestionBankImportJobRoute } from "@/app/api/admin/question-banks/import/[jobId]/route";
import { createAdminQuestionBankImportConfirmRoute } from "@/app/api/admin/question-banks/import/[jobId]/confirm/route";
import { createAdminQuestionBankImportTemplatesRoute } from "@/app/api/admin/question-banks/import/templates/[kind]/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createStandardExcelWorkbook } from "../fixtures/question-bank-import";
import { createTestDatabase } from "../helpers/test-db";

describe("question bank import routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminToken: string;
  let superAdminToken: string;
  let employeeToken: string;
  let privateRoot: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-qb-import-route-"));
    const passwordHash = await hashPassword("ImportRoutes123");
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "IMP-A",
        name: "导入路由管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    const superAdmin = await testDb.db.user.create({
      data: {
        employeeNo: "IMP-S",
        name: "导入路由超管",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "IMP-E",
        name: "导入路由员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    superAdminToken = (await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
  });

  afterEach(async () => {
    await testDb.cleanup();
    await rm(privateRoot, { recursive: true, force: true });
  });

  const deps = () => ({ db: testDb.db, privateRoot });

  function cookieRequest(url: string, token: string, init: RequestInit = {}) {
    return new Request(`http://localhost:3000${url}`, {
      ...init,
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin: "http://localhost:3000",
        ...(init.headers ?? {}),
      },
    });
  }

  it("allows admin and super admin upload/status/confirm; rejects employee", async () => {
    const importRoute = createAdminQuestionBankImportRoute(deps());
    const excelBytes = Buffer.from(createStandardExcelWorkbook());
    const form = new FormData();
    form.set(
      "file",
      new File(
        [excelBytes],
        "template.xlsx",
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ),
    );

    const employeeDenied = await importRoute.POST(
      cookieRequest("/api/admin/question-banks/import", employeeToken, { method: "POST", body: form }),
    );
    expect(employeeDenied.status).toBe(403);

    const form2 = new FormData();
    form2.set(
      "file",
      new File(
        [excelBytes],
        "template.xlsx",
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ),
    );
    const uploaded = await importRoute.POST(
      cookieRequest("/api/admin/question-banks/import", adminToken, { method: "POST", body: form2 }),
    );
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as {
      ok: boolean;
      job: { id: string; status: string; stage: string; questions: Array<{ options: Array<{ isCorrect?: boolean }> }> };
    };
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe("REVIEW_READY");
    expect(body.job.stage).toBe("REVIEW");
    // Admin preview includes answers
    expect(JSON.stringify(body.job)).toContain("isCorrect");

    const jobRoute = createAdminQuestionBankImportJobRoute(deps(), body.job.id);
    const polled = await jobRoute.GET(
      cookieRequest(`/api/admin/question-banks/import/${body.job.id}`, superAdminToken),
    );
    expect(polled.status).toBe(200);
    const polledBody = await polled.json();
    expect(polledBody.ok).toBe(true);
    expect(polledBody.job.questions.length).toBeGreaterThan(0);

    const confirmRoute = createAdminQuestionBankImportConfirmRoute(deps(), body.job.id);
    const confirmed = await confirmRoute.POST(
      cookieRequest(`/api/admin/question-banks/import/${body.job.id}/confirm`, superAdminToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankName: "路由确认题库" }),
      }),
    );
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json();
    expect(confirmedBody.ok).toBe(true);
    expect(confirmedBody.bank.id).toBeTruthy();
    expect(confirmedBody.bank.questionCount).toBeGreaterThan(0);

    // Employee still cannot read import job (and must not see answers)
    const employeeGet = await jobRoute.GET(
      cookieRequest(`/api/admin/question-banks/import/${body.job.id}`, employeeToken),
    );
    expect(employeeGet.status).toBe(403);
  });

  it("serves standard word/excel templates and instructions", async () => {
    for (const kind of ["word", "excel", "instructions"] as const) {
      const route = createAdminQuestionBankImportTemplatesRoute(deps(), kind);
      const allowed = await route.GET(
        cookieRequest(`/api/admin/question-banks/import/templates/${kind}`, adminToken),
      );
      expect(allowed.status).toBe(200);
      expect(Number(allowed.headers.get("content-length") ?? "1")).toBeGreaterThan(0);

      const denied = await route.GET(
        cookieRequest(`/api/admin/question-banks/import/templates/${kind}`, employeeToken),
      );
      expect(denied.status).toBe(403);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdminResultsRoute } from "@/app/api/admin/results/route";
import { createRetakesListRoute } from "@/app/api/admin/retakes/route";
import { createRosterHistoryRoute } from "@/app/api/admin/roster/preview/route";
import {
  AssignmentStatus,
  ImportBatchStatus,
  RetakeStatus,
  Role,
  SessionViewMode,
  UserSource,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("dashboard target filter routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let token: string;
  let administratorId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("DashboardFilter123");
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-DASH-FILTER",
        name: "看板筛选管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    administratorId = administrator.id;
    token = (await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.ADMIN,
    })).token;
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  function request(path: string) {
    return new Request(`http://localhost:3000${path}`, {
      headers: { cookie: `cohort_harbor_session=${token}` },
    });
  }

  it("filters result assignments by the validated status query", async () => {
    const passwordHash = await hashPassword("EmployeeFilter123");
    const users = await Promise.all(["PASSED", "FAILED"].map((suffix) =>
      testDb.db.user.create({
        data: {
          employeeNo: `RESULT-${suffix}`,
          name: `成绩${suffix}`,
          sourceType: UserSource.MANUAL,
          passwordHash,
        },
      })));
    const exam = await testDb.db.exam.create({ data: { name: "筛选考试" } });
    await testDb.db.examAssignment.createMany({
      data: [
        { userId: users[0]!.id, examId: exam.id, status: AssignmentStatus.PASSED, dueAt: new Date("2026-08-01T00:00:00Z") },
        { userId: users[1]!.id, examId: exam.id, status: AssignmentStatus.FAILED, dueAt: new Date("2026-08-01T00:00:00Z") },
      ],
    });

    const response = await createAdminResultsRoute({ db: testDb.db })(
      request("/api/admin/results?status=PASSED"),
    );
    const body = await response.json() as { assignments: Array<{ status: string }> };

    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]?.status).toBe(AssignmentStatus.PASSED);
  });

  it("filters retake applications by the validated status query", async () => {
    const passwordHash = await hashPassword("RetakeFilter123");
    const employee = await testDb.db.user.create({
      data: { employeeNo: "RETAKE-FILTER", name: "补考筛选员工", sourceType: UserSource.MANUAL, passwordHash },
    });
    const exam = await testDb.db.exam.create({ data: { name: "补考筛选考试" } });
    const assignment = await testDb.db.examAssignment.create({
      data: { userId: employee.id, examId: exam.id, dueAt: new Date("2026-08-01T00:00:00Z") },
    });
    await testDb.db.retakeApplication.createMany({
      data: [
        { assignmentId: assignment.id, requesterId: employee.id, reason: "待审批补考筛选原因说明", status: RetakeStatus.PENDING },
        { assignmentId: assignment.id, requesterId: employee.id, reason: "已审批补考筛选原因说明", status: RetakeStatus.APPROVED },
      ],
    });

    const response = await createRetakesListRoute({ db: testDb.db })(
      request("/api/admin/retakes?status=APPROVED"),
    );
    const body = await response.json() as { applications: Array<{ status: string }> };

    expect(body.applications).toHaveLength(1);
    expect(body.applications[0]?.status).toBe(RetakeStatus.APPROVED);
  });

  it("filters roster history by the validated status query", async () => {
    await testDb.db.rosterImportBatch.createMany({
      data: [
        {
          sourceName: "dashboard-filter",
          originalFileName: "committed.xlsx",
          fileHash: "committed-filter",
          status: ImportBatchStatus.COMMITTED,
          actorId: administratorId,
          actorSnapshot: { employeeNo: "ADMIN-DASH-FILTER", name: "看板筛选管理员", role: Role.ADMIN },
        },
        {
          sourceName: "dashboard-filter",
          originalFileName: "failed.xlsx",
          fileHash: "failed-filter",
          status: ImportBatchStatus.FAILED,
          actorId: administratorId,
          actorSnapshot: { employeeNo: "ADMIN-DASH-FILTER", name: "看板筛选管理员", role: Role.ADMIN },
        },
      ],
    });

    const response = await createRosterHistoryRoute({ db: testDb.db })(
      request("/api/admin/roster/preview?status=FAILED"),
    );
    const body = await response.json() as { batches: Array<{ status: string }> };

    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]?.status).toBe(ImportBatchStatus.FAILED);
  });
});

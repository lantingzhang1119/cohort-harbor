import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AssignmentStatus,
  ImportBatchStatus,
  RetakeStatus,
  Role,
  UserSource,
  WorkLocation,
} from "@/generated/prisma/enums";
import {
  getAdminDashboard,
  getEmployeeDashboard,
} from "@/features/dashboard/dashboard-service";
import { hashPassword } from "@/features/auth/password";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { createTestDatabase } from "../helpers/test-db";

describe("dashboard aggregation", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminId: string;
  let employeeIds: string[];

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("DashboardPass!23");
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-DASH",
        name: "看板管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
      },
    });
    adminId = admin.id;
    const employees = await Promise.all([
      testDb.db.user.create({ data: { employeeNo: "DASH-01", name: "员工甲", sourceType: UserSource.MANUAL, workLocation: WorkLocation.SHANGHAI, passwordHash } }),
      testDb.db.user.create({ data: { employeeNo: "DASH-02", name: "员工乙", sourceType: UserSource.MANUAL, workLocation: WorkLocation.UNSET, passwordHash } }),
      testDb.db.user.create({ data: { employeeNo: "DASH-03", name: "员工丙", sourceType: UserSource.MANUAL, workLocation: WorkLocation.UNSET, enabled: false, passwordHash } }),
    ]);
    employeeIds = employees.map((employee) => employee.id);

    const exam = await testDb.db.exam.create({ data: { name: "看板测试考试" } });
    const assignments = await Promise.all([
      testDb.db.examAssignment.create({ data: { userId: employeeIds[0], examId: exam.id, status: AssignmentStatus.PASSED, dueAt: new Date("2026-07-20T00:00:00Z") } }),
      testDb.db.examAssignment.create({ data: { userId: employeeIds[1], examId: exam.id, status: AssignmentStatus.IN_PROGRESS, dueAt: new Date("2026-07-21T00:00:00Z") } }),
      testDb.db.examAssignment.create({ data: { userId: employeeIds[2], examId: exam.id, status: AssignmentStatus.PENDING_APPROVAL, dueAt: new Date("2026-07-22T00:00:00Z") } }),
    ]);
    await testDb.db.retakeApplication.create({
      data: { assignmentId: assignments[2].id, requesterId: employeeIds[2], reason: "已经完成复习，申请再次参加考试。", status: RetakeStatus.PENDING },
    });
    await testDb.db.rosterImportBatch.create({
      data: {
        sourceName: "excel-local",
        originalFileName: "synthetic-roster.xlsx",
        fileHash: "dashboard-fixture",
        status: ImportBatchStatus.COMMITTED,
        totalRows: 3,
        createdCount: 2,
        updatedCount: 1,
        actorId: adminId,
        actorSnapshot: snapshotUserIdentity(admin),
        committedAt: new Date("2026-07-16T02:00:00Z"),
      },
    });
  });

  afterEach(async () => testDb.cleanup());

  it("returns aggregate-only administrator metrics", async () => {
    const result = await getAdminDashboard(testDb.db);

    expect(result.employees).toEqual({ total: 3, enabled: 2, disabled: 1, unsetLocation: 2 });
    expect(result.examStatuses).toMatchObject({ PASSED: 1, IN_PROGRESS: 1, PENDING_APPROVAL: 1 });
    expect(result.passRate).toBe(33);
    expect(result.pendingRetakes).toBe(1);
    expect(result.recentImports).toEqual([
      expect.objectContaining({ sourceName: "excel-local", totalRows: 3, createdCount: 2, updatedCount: 1 }),
    ]);
    expect(JSON.stringify(result)).not.toContain("员工甲");
    expect(JSON.stringify(result)).not.toContain("DASH-01");
  });

  it("scopes employee progress and unread notices to that employee", async () => {
    await testDb.db.notification.createMany({
      data: [
        { userId: employeeIds[0], type: "REMINDER", title: "待办", body: "请完成学习" },
        { userId: employeeIds[1], type: "SYSTEM", title: "其他人", body: "不可见" },
      ],
    });
    const result = await getEmployeeDashboard(testDb.db, employeeIds[0]);

    expect(result.profile).toMatchObject({ name: "员工甲", employeeNo: "DASH-01", workLocation: WorkLocation.SHANGHAI });
    expect(result.assignment).toMatchObject({ status: AssignmentStatus.PASSED, examName: "看板测试考试" });
    expect(result.unreadNotifications).toBe(1);
  });
});

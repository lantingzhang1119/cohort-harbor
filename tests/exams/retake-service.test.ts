import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssignmentStatus, RetakeStatus, Role, UserSource } from "@/generated/prisma/enums";
import {
  applyForRetake,
  reviewRetake,
  transitionAfterFailedAttempt,
} from "@/features/exams/retake-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("retake state machine", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let assignmentId: string;
  let userId: string;
  let adminId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    adminId = (await testDb.db.user.create({ data: { employeeNo: "ADMIN-RETAKE", name: "补考管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })).id;
    userId = (await testDb.db.user.create({ data: { employeeNo: "TEST-RETAKE", name: "补考员工", sourceType: UserSource.MANUAL, passwordHash } })).id;
    const exam = await testDb.db.exam.create({ data: { name: "补考测试" } });
    assignmentId = (await testDb.db.examAssignment.create({ data: { userId, examId: exam.id, dueAt: new Date("2026-08-01T00:00:00.000Z") } })).id;
  });
  afterEach(async () => testDb.cleanup());

  it("automatically grants one retry after the first failure", async () => {
    await transitionAfterFailedAttempt(testDb.db, assignmentId, 1);
    const assignment = await testDb.db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: AssignmentStatus.RETAKE_READY, allowedAttempts: 2 });
  });

  it("requires an application after the second and later failures", async () => {
    await testDb.db.examAssignment.update({ where: { id: assignmentId }, data: { allowedAttempts: 2 } });
    await transitionAfterFailedAttempt(testDb.db, assignmentId, 2);
    expect((await testDb.db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe(AssignmentStatus.APPLICATION_REQUIRED);
  });

  it("prevents duplicate pending applications and approval adds exactly one chance", async () => {
    await testDb.db.examAssignment.update({ where: { id: assignmentId }, data: { status: AssignmentStatus.APPLICATION_REQUIRED, allowedAttempts: 2 } });
    const application = await applyForRetake(testDb.db, assignmentId, userId, "已经复习相关制度，希望补考");
    expect(application.status).toBe(RetakeStatus.PENDING);
    await expect(applyForRetake(testDb.db, assignmentId, userId, "重复申请原因" )).rejects.toThrow();
    await reviewRetake(testDb.db, application.id, adminId, { approve: true, note: "同意" });
    const assignment = await testDb.db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: AssignmentStatus.RETAKE_READY, allowedAttempts: 3 });
    expect(await testDb.db.notification.count({ where: { userId } })).toBe(1);

    await transitionAfterFailedAttempt(testDb.db, assignmentId, 3);
    expect((await testDb.db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe(AssignmentStatus.APPLICATION_REQUIRED);
  });

  it("rejection notifies the employee without adding a chance", async () => {
    await testDb.db.examAssignment.update({ where: { id: assignmentId }, data: { status: AssignmentStatus.APPLICATION_REQUIRED, allowedAttempts: 2 } });
    const application = await applyForRetake(testDb.db, assignmentId, userId, "申请补考原因不少于十字");
    await reviewRetake(testDb.db, application.id, adminId, { approve: false, note: "请先完成制度复习" });
    const assignment = await testDb.db.examAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: AssignmentStatus.APPLICATION_REQUIRED, allowedAttempts: 2 });
    expect((await testDb.db.notification.findFirstOrThrow({ where: { userId } })).title).toContain("未通过");
  });
});

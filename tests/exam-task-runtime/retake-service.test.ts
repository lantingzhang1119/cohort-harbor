import { afterEach, describe, expect, it } from "vitest";

import { AssignmentStatus, RetakeStatus, Role, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import {
  applyForTaskRetake,
  reviewTaskRetake,
} from "@/features/exam-task-runtime/retake-service";
import { createExamTaskFixture } from "../helpers/exam-task-fixture";

describe("exam task retake applications", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  it("enforces ownership, admin approval and one pending application", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    await fixture.testDb.db.examTaskAssignment.update({
      where: { id: assignment.id },
      data: { status: AssignmentStatus.APPLICATION_REQUIRED, currentAttemptCount: 2 },
    });
    await expect(
      applyForTaskRetake(
        fixture.testDb.db,
        assignment.id,
        fixture.employees[1]!.id,
        "我已经完成复习，希望再次补考",
        new Date("2026-08-03T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const application = await applyForTaskRetake(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      "我已经完成复习，希望再次补考",
      new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(application.status).toBe(RetakeStatus.PENDING);
    await expect(
      applyForTaskRetake(
        fixture.testDb.db,
        assignment.id,
        assignment.userId,
        "第二次重复提交同一个待审批申请",
        new Date("2026-08-03T00:01:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const employeeReviewer = await fixture.testDb.db.user.create({
      data: {
        employeeNo: "RT-REVIEW-E",
        name: "无权审批员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("x"),
        mustChangePassword: false,
      },
    });
    await expect(
      reviewTaskRetake(
        fixture.testDb.db,
        application.id,
        employeeReviewer.id,
        { approve: true },
        new Date("2026-08-03T00:02:00.000Z"),
      ),
    ).rejects.toThrow();
    await reviewTaskRetake(
      fixture.testDb.db,
      application.id,
      fixture.admin.id,
      { approve: true, note: "同意" },
      new Date("2026-08-03T00:03:00.000Z"),
    );
    const updated = await fixture.testDb.db.examTaskAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(updated.status).toBe(AssignmentStatus.RETAKE_READY);
    expect(await fixture.testDb.db.auditLog.count({ where: { action: "EXAM_TASK_RETAKE_REVIEW" } })).toBe(1);
    expect(await fixture.testDb.db.notification.count({ where: { examTaskAssignmentId: assignment.id } })).toBe(2);
  });
});

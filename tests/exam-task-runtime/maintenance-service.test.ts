import { afterEach, describe, expect, it } from "vitest";

import {
  AssignmentStatus,
  AttemptStatus,
  NotificationType,
} from "@/generated/prisma/enums";
import { startTaskAttempt } from "@/features/exam-task-runtime/attempt-service";
import {
  generateExamTaskReminders,
  processExpiredExamTasks,
} from "@/features/exam-task-runtime/maintenance-service";
import { createExamTaskFixture } from "../helpers/exam-task-fixture";

describe("exam task deadline and reminder maintenance", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  it("auto-submits started attempts and marks never-entered assignments overdue idempotently", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const startedAssignment = fixture.assignments[0]!;
    const untouchedAssignment = fixture.assignments[1]!;
    const attempt = await startTaskAttempt(
      fixture.testDb.db,
      startedAssignment.id,
      startedAssignment.userId,
      new Date("2026-08-09T23:00:00.000Z"),
    );
    const first = await processExpiredExamTasks(
      fixture.testDb.db,
      new Date("2026-08-10T00:01:00.000Z"),
    );
    expect(first).toEqual({ inspected: 2, submitted: 1, overdue: 1 });
    const second = await processExpiredExamTasks(
      fixture.testDb.db,
      new Date("2026-08-10T00:02:00.000Z"),
    );
    expect(second).toEqual({ inspected: 0, submitted: 0, overdue: 0 });
    expect((await fixture.testDb.db.examTaskAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } })).status)
      .toBe(AttemptStatus.EXPIRED);
    expect((await fixture.testDb.db.examTaskAssignment.findUniqueOrThrow({ where: { id: untouchedAssignment.id } })).status)
      .toBe(AssignmentStatus.OVERDUE);
  });

  it("creates 24h and 2h reminders once and skips completed employees", async () => {
    const fixture = await createExamTaskFixture({
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    cleanup = fixture.testDb.cleanup;
    await fixture.testDb.db.examTaskAssignment.update({
      where: { id: fixture.assignments[1]!.id },
      data: { status: AssignmentStatus.PASSED, score: 100, passed: true },
    });
    const at24 = await generateExamTaskReminders(
      fixture.testDb.db,
      new Date("2026-08-02T01:00:00.000Z"),
    );
    expect(at24.created).toBe(1);
    expect((await generateExamTaskReminders(
      fixture.testDb.db,
      new Date("2026-08-02T01:01:00.000Z"),
    )).created).toBe(0);
    const at2 = await generateExamTaskReminders(
      fixture.testDb.db,
      new Date("2026-08-02T22:30:00.000Z"),
    );
    expect(at2.created).toBe(1);
    const notifications = await fixture.testDb.db.notification.findMany({
      where: { userId: fixture.assignments[0]!.userId },
    });
    expect(notifications.filter((item) => item.type === NotificationType.EXAM_DUE_24H)).toHaveLength(1);
    expect(notifications.filter((item) => item.type === NotificationType.EXAM_DUE_2H)).toHaveLength(1);
  });

  it("does not create a stale 24h reminder for tasks shorter than 24h", async () => {
    const fixture = await createExamTaskFixture({
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-01T03:00:00.000Z"),
      employeeCount: 1,
    });
    cleanup = fixture.testDb.cleanup;
    const result = await generateExamTaskReminders(
      fixture.testDb.db,
      new Date("2026-08-01T01:30:00.000Z"),
    );
    expect(result.created).toBe(1);
    const notifications = await fixture.testDb.db.notification.findMany({
      where: { examTaskAssignmentId: fixture.assignments[0]!.id },
    });
    expect(notifications.some((item) => item.type === NotificationType.EXAM_DUE_24H)).toBe(false);
    expect(notifications.some((item) => item.type === NotificationType.EXAM_DUE_2H)).toBe(true);
  });
});

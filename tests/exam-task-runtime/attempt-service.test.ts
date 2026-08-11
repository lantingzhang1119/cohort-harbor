import { afterEach, describe, expect, it } from "vitest";

import { AssignmentStatus, AttemptStatus } from "@/generated/prisma/enums";
import {
  getTaskAttemptForUser,
  saveTaskAnswer,
  startTaskAttempt,
  submitTaskAttempt,
} from "@/features/exam-task-runtime/attempt-service";
import { ExamTaskRuntimeError } from "@/features/exam-task-runtime/errors";
import { createExamTaskFixture } from "../helpers/exam-task-fixture";

describe("employee exam task attempt service", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  it("enforces ownership and start/end windows on every access", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments.find((item) => item.userId === fixture.employees[0]!.id)!;
    await expect(
      startTaskAttempt(
        fixture.testDb.db,
        assignment.id,
        fixture.employees[0]!.id,
        new Date("2026-07-31T23:59:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "NOT_STARTED" });
    await expect(
      startTaskAttempt(
        fixture.testDb.db,
        assignment.id,
        fixture.employees[1]!.id,
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns a safe immutable paper without correct or acceptable answers", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const attempt = await startTaskAttempt(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const serialized = JSON.stringify(attempt);
    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("acceptableAnswers");
    expect(serialized).not.toContain("SHANGHAI");
    expect(attempt.questions).toHaveLength(2);
    expect(attempt.expiresAt.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("auto-saves choice/fill answers, scores normalized values and is submit-idempotent", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const now = new Date("2026-08-02T00:00:00.000Z");
    const attempt = await startTaskAttempt(fixture.testDb.db, assignment.id, assignment.userId, now);
    const choice = attempt.questions.find((question) => question.id === fixture.choice.id)!;
    await saveTaskAnswer(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      choice.id,
      { selectedOptionIds: [choice.options.find((option) => option.text === "上海")!.id] },
      now,
    );
    await saveTaskAnswer(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      fixture.fill.id,
      { values: ["ＳＨＡＮＧＨＡＩ", "80，分"] },
      now,
    );
    const loaded = await getTaskAttemptForUser(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      now,
    );
    expect(loaded.answers[fixture.fill.id]).toEqual({ values: ["ＳＨＡＮＧＨＡＩ", "80，分"] });
    const first = await submitTaskAttempt(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      new Date("2026-08-02T00:05:00.000Z"),
    );
    expect(first).toMatchObject({ score: 100, passed: true, replayed: false });
    const replay = await submitTaskAttempt(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      new Date("2026-08-02T00:06:00.000Z"),
    );
    expect(replay).toMatchObject({ score: 100, passed: true, replayed: true });
    await expect(getTaskAttemptForUser(
      fixture.testDb.db,
      attempt.attemptId,
      assignment.userId,
      new Date("2026-08-02T00:07:00.000Z"),
    )).rejects.toMatchObject({ code: "ATTEMPT_CLOSED" });
    const stored = await fixture.testDb.db.examTaskAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(stored.status).toBe(AssignmentStatus.PASSED);
    expect(await fixture.testDb.db.examTaskAttempt.count()).toBe(1);
  });

  it("offers one automatic retake, then requires an approved application", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const first = await startTaskAttempt(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      new Date("2026-08-02T00:00:00.000Z"),
    );
    await submitTaskAttempt(
      fixture.testDb.db,
      first.attemptId,
      assignment.userId,
      new Date("2026-08-02T00:01:00.000Z"),
    );
    expect((await fixture.testDb.db.examTaskAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status)
      .toBe(AssignmentStatus.RETAKE_READY);
    const second = await startTaskAttempt(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      new Date("2026-08-02T00:02:00.000Z"),
    );
    await submitTaskAttempt(
      fixture.testDb.db,
      second.attemptId,
      assignment.userId,
      new Date("2026-08-02T00:03:00.000Z"),
    );
    expect((await fixture.testDb.db.examTaskAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status)
      .toBe(AssignmentStatus.APPLICATION_REQUIRED);
    await expect(
      startTaskAttempt(
        fixture.testDb.db,
        assignment.id,
        assignment.userId,
        new Date("2026-08-02T00:04:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(ExamTaskRuntimeError);
  });

  it("submits the last saved answers when a save arrives after the deadline", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const attempt = await startTaskAttempt(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      new Date("2026-08-09T23:00:00.000Z"),
    );
    await expect(
      saveTaskAnswer(
        fixture.testDb.db,
        attempt.attemptId,
        assignment.userId,
        fixture.fill.id,
        { values: ["上海", "80分"] },
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "ATTEMPT_CLOSED" });
    const stored = await fixture.testDb.db.examTaskAttempt.findUniqueOrThrow({
      where: { id: attempt.attemptId },
    });
    expect(stored.status).toBe(AttemptStatus.EXPIRED);
  });

  it("reuses the single active attempt when start is clicked concurrently", async () => {
    const fixture = await createExamTaskFixture({ employeeCount: 1 });
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const now = new Date("2026-08-02T00:00:00.000Z");
    const attempts = await Promise.all([
      startTaskAttempt(fixture.testDb.db, assignment.id, assignment.userId, now),
      startTaskAttempt(fixture.testDb.db, assignment.id, assignment.userId, now),
    ]);
    expect(attempts[0].attemptId).toBe(attempts[1].attemptId);
    expect(await fixture.testDb.db.examTaskAttempt.count({ where: { assignmentId: assignment.id } })).toBe(1);
  });

  it("keeps concurrent submit idempotent", async () => {
    const fixture = await createExamTaskFixture({ employeeCount: 1 });
    cleanup = fixture.testDb.cleanup;
    const assignment = fixture.assignments[0]!;
    const attempt = await startTaskAttempt(
      fixture.testDb.db,
      assignment.id,
      assignment.userId,
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const results = await Promise.all([
      submitTaskAttempt(fixture.testDb.db, attempt.attemptId, assignment.userId, new Date("2026-08-02T00:01:00.000Z")),
      submitTaskAttempt(fixture.testDb.db, attempt.attemptId, assignment.userId, new Date("2026-08-02T00:01:00.000Z")),
    ]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await fixture.testDb.db.examTaskAttempt.count({ where: { assignmentId: assignment.id } })).toBe(1);
  });

  it("never leaves an unscored answer on a closed attempt when save and submit race", async () => {
    const fixture = await createExamTaskFixture({ employeeCount: 24 });
    cleanup = fixture.testDb.cleanup;
    const now = new Date("2026-08-02T00:00:00.000Z");
    const attempts = await Promise.all(fixture.assignments.map((assignment) =>
      startTaskAttempt(fixture.testDb.db, assignment.id, assignment.userId, now),
    ));

    await Promise.all(attempts.map(async (attempt, index) => {
      const assignment = fixture.assignments[index]!;
      const choice = attempt.questions.find((question) => question.id === fixture.choice.id)!;
      await Promise.all([
        saveTaskAnswer(
          fixture.testDb.db,
          attempt.attemptId,
          assignment.userId,
          choice.id,
          { selectedOptionIds: [choice.options.find((option) => option.text === "上海")!.id] },
          now,
        ).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "ATTEMPT_CLOSED" });
        }),
        submitTaskAttempt(
          fixture.testDb.db,
          attempt.attemptId,
          assignment.userId,
          new Date("2026-08-02T00:01:00.000Z"),
        ),
      ]);
    }));

    const unscored = await fixture.testDb.db.examTaskAnswer.count({
      where: {
        awardedScore: null,
        attempt: { status: { not: AttemptStatus.IN_PROGRESS } },
      },
    });
    expect(unscored).toBe(0);
  });
});

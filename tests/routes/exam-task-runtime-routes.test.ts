import { afterEach, describe, expect, it } from "vitest";

import { createTaskAttemptAnswerRoute } from "@/app/api/exam/task-attempts/[id]/answer/route";
import { createSubmitTaskAttemptRoute } from "@/app/api/exam/task-attempts/[id]/submit/route";
import { createAdminResultsRoute } from "@/app/api/admin/results/route";
import { createEmployeeExamTasksRoute } from "@/app/api/exam/tasks/route";
import { createStartTaskAttemptRoute } from "@/app/api/exam/tasks/[id]/start/route";
import { SessionViewMode } from "@/generated/prisma/enums";
import { createSession } from "@/features/auth/session";
import { createExamTaskFixture } from "../helpers/exam-task-fixture";

describe("employee exam task runtime routes", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => cleanup?.());

  const request = (url: string, token: string, method = "GET", body?: unknown) =>
    new Request(`http://localhost:3000${url}`, {
      method,
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin: "http://localhost:3000",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("lists only the current employee tasks and rejects cross-account start", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const first = fixture.employees[0]!;
    const second = fixture.employees[1]!;
    const token = (await createSession(fixture.testDb.db, first.id, {
      viewMode: SessionViewMode.EMPLOYEE,
      now: new Date("2026-08-02T00:00:00.000Z"),
    })).token;
    const listRoute = createEmployeeExamTasksRoute({
      db: fixture.testDb.db,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    const list = await listRoute(request("/api/exam/tasks", token));
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(listBody.tasks).toHaveLength(1);
    expect(listBody.tasks[0].id).toBe(
      fixture.assignments.find((assignment) => assignment.userId === first.id)!.id,
    );

    const otherAssignment = fixture.assignments.find((assignment) => assignment.userId === second.id)!;
    const startRoute = createStartTaskAttemptRoute(
      { db: fixture.testDb.db, now: () => new Date("2026-08-02T00:00:00.000Z") },
      otherAssignment.id,
    );
    const denied = await startRoute(request(`/api/exam/tasks/${otherAssignment.id}/start`, token, "POST"));
    expect(denied.status).toBe(403);
  });

  it("starts, loads, saves and submits through safe employee DTOs", async () => {
    const fixture = await createExamTaskFixture({ employeeCount: 1 });
    cleanup = fixture.testDb.cleanup;
    const employee = fixture.employees[0]!;
    const assignment = fixture.assignments[0]!;
    const token = (await createSession(fixture.testDb.db, employee.id, {
      viewMode: SessionViewMode.EMPLOYEE,
      now: new Date("2026-08-02T00:00:00.000Z"),
    })).token;
    const deps = { db: fixture.testDb.db, now: () => new Date("2026-08-02T00:00:00.000Z") };
    const start = await createStartTaskAttemptRoute(deps, assignment.id)(
      request(`/api/exam/tasks/${assignment.id}/start`, token, "POST"),
    );
    const started = await start.json();
    expect(start.status).toBe(200);
    expect(JSON.stringify(started)).not.toContain("isCorrect");
    expect(JSON.stringify(started)).not.toContain("acceptableAnswers");

    const answerRoute = createTaskAttemptAnswerRoute(deps, started.attemptId);
    const loaded = await answerRoute.GET(
      request(`/api/exam/task-attempts/${started.attemptId}/answer`, token),
    );
    const loadedBody = await loaded.json();
    expect(loaded.status).toBe(200);
    expect(JSON.stringify(loadedBody)).not.toContain("isCorrect");
    const choice = loadedBody.questions.find((question: { id: string }) => question.id === fixture.choice.id);
    const correctDisplayOption = choice.options.find((option: { text: string }) => option.text === "上海");
    const saved = await answerRoute.POST(
      request(`/api/exam/task-attempts/${started.attemptId}/answer`, token, "POST", {
        questionId: choice.id,
        response: { selectedOptionIds: [correctDisplayOption.id] },
      }),
    );
    expect(saved.status).toBe(200);

    const submitted = await createSubmitTaskAttemptRoute(deps, started.attemptId)(
      request(`/api/exam/task-attempts/${started.attemptId}/submit`, token, "POST", {}),
    );
    const submittedBody = await submitted.json();
    expect(submitted.status).toBe(200);
    expect(submittedBody.score).toBe(40);
    expect(submittedBody.passed).toBe(false);
  });

  it("lets administrators filter new results by task, bank, employee and status", async () => {
    const fixture = await createExamTaskFixture();
    cleanup = fixture.testDb.cleanup;
    const token = (await createSession(fixture.testDb.db, fixture.admin.id, {
      viewMode: SessionViewMode.ADMIN,
    })).token;
    const response = await createAdminResultsRoute({ db: fixture.testDb.db })(
      request(
        "/api/admin/results?status=NOT_STARTED&task=运行时任务&bank=运行时试卷&employee=RT-E1",
        token,
      ),
    );
    const body = (await response.json()) as { taskAssignments: Array<{ user: { employeeNo: string } }> };
    expect(response.status).toBe(200);
    expect(body.taskAssignments).toHaveLength(1);
    expect(body.taskAssignments[0]?.user.employeeNo).toBe("RT-E1");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuestionType, Role, SessionViewMode, UserSource } from "@/generated/prisma/enums";
import { createAnswerRoute } from "@/app/api/exam/attempt/[id]/answer/route";
import { createSubmitRoute } from "@/app/api/exam/attempt/[id]/submit/route";
import { createStartRoute } from "@/app/api/exam/start/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("exam routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let token: string;
  const now = new Date("2026-07-16T11:00:00.000Z");

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const user = await testDb.db.user.create({ data: { employeeNo: "TEST-EXAM-ROUTE", name: "路由考试员工", sourceType: UserSource.MANUAL, mustChangePassword: false, passwordHash: await hashPassword("InitialPass!23") } });
    token = (await createSession(testDb.db, user.id)).token;
    const exam = await testDb.db.exam.create({ data: { name: "路由考试", durationMinutes: 30, passingScore: 80 } });
    const question = await testDb.db.question.create({ data: { examId: exam.id, sequence: 1, type: QuestionType.SINGLE, prompt: "路由题目", score: 100 } });
    await testDb.db.questionOption.createMany({ data: [{ questionId: question.id, optionKey: "A", text: "正确", isCorrect: true, sortOrder: 0 }, { questionId: question.id, optionKey: "B", text: "错误", isCorrect: false, sortOrder: 1 }] });
  });
  afterEach(async () => testDb.cleanup());

  function request(path: string, body?: object, authenticated = true) {
    return new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        ...(authenticated ? { cookie: `cohort_harbor_session=${token}` } : {}),
        origin: "http://localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("starts, autosaves and submits without leaking answer keys", async () => {
    const start = createStartRoute({ db: testDb.db, now: () => now });
    const startResponse = await start(request("/api/exam/start"));
    expect(startResponse.status).toBe(200);
    const attempt = await startResponse.json() as { attemptId: string; questions: Array<{ questionId: string }> };
    expect(JSON.stringify(attempt)).not.toContain("correctOptionKeys");
    const questionId = attempt.questions[0]!.questionId;
    const answer = createAnswerRoute({ db: testDb.db, now: () => now }, attempt.attemptId);
    expect((await answer(request(`/api/exam/attempt/${attempt.attemptId}/answer`, { questionId, selectedKeys: ["A"] }))).status).toBe(200);
    const submit = createSubmitRoute({ db: testDb.db, now: () => new Date("2026-07-16T11:05:00.000Z") }, attempt.attemptId);
    const result = await submit(request(`/api/exam/attempt/${attempt.attemptId}/submit`, {}));
    expect(await result.json()).toMatchObject({ ok: true, score: 100, passed: true });
  });

  it("denies unauthenticated start and answer requests", async () => {
    const start = createStartRoute({ db: testDb.db, now: () => now });
    expect((await start(request("/api/exam/start", undefined, false))).status).toBe(401);
  });

  it("does not auto-create an assignment for a management account in employee view", async () => {
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-NO-ASSIGNMENT",
        name: "无任务管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });
    const administratorSession = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const adminRequest = new Request("http://localhost:3000/api/exam/start", {
      method: "POST",
      headers: {
        cookie: `cohort_harbor_session=${administratorSession.token}`,
        origin: "http://localhost:3000",
      },
    });

    const response = await createStartRoute({ db: testDb.db, now: () => now })(adminRequest);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "当前管理账号暂无学习任务",
    });
    expect(await testDb.db.examAssignment.count({ where: { userId: administrator.id } })).toBe(0);
  });

  it("does not start from a management account's obsolete disabled-exam assignment", async () => {
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-DISABLED-EXAM",
        name: "旧考试管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });
    const disabledExam = await testDb.db.exam.create({
      data: { name: "旧版已停用考试", enabled: false },
    });
    await testDb.db.examAssignment.create({
      data: {
        userId: administrator.id,
        examId: disabledExam.id,
        dueAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const administratorSession = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.EMPLOYEE,
    });
    const adminRequest = new Request("http://localhost:3000/api/exam/start", {
      method: "POST",
      headers: {
        cookie: `cohort_harbor_session=${administratorSession.token}`,
        origin: "http://localhost:3000",
      },
    });

    const response = await createStartRoute({ db: testDb.db, now: () => now })(adminRequest);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: "当前管理账号暂无学习任务",
    });
    expect(await testDb.db.examAssignment.count({ where: { userId: administrator.id } })).toBe(1);
  });

  it("denies employee-domain exam APIs while an administrator session is in ADMIN mode", async () => {
    const administrator = await testDb.db.user.create({
      data: {
        employeeNo: "ADMIN-ADMIN-VIEW",
        name: "管理视图管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash: await hashPassword("InitialPass!23"),
      },
    });
    const administratorSession = await createSession(testDb.db, administrator.id, {
      viewMode: SessionViewMode.ADMIN,
    });
    const adminRequest = new Request("http://localhost:3000/api/exam/start", {
      method: "POST",
      headers: {
        cookie: `cohort_harbor_session=${administratorSession.token}`,
        origin: "http://localhost:3000",
      },
    });

    expect(
      (await createStartRoute({ db: testDb.db, now: () => now })(adminRequest)).status,
    ).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QuestionBankQuestionType,
  QuestionBankStatus,
  Role,
  SessionViewMode,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import { createAdminExamTasksRoute } from "@/app/api/admin/exam-tasks/route";
import { createAdminExamTaskResolveAssigneesRoute } from "@/app/api/admin/exam-tasks/resolve-assignees/route";
import { createAdminExamTaskSelectableBanksRoute } from "@/app/api/admin/exam-tasks/selectable-banks/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import {
  createBlankQuestionBank,
  setDefaultQuestionBank,
  setQuestionBankStatus,
} from "@/features/question-banks/question-bank-service";
import { createQuestionBankQuestion } from "@/features/question-banks/question-service";
import { createTestDatabase } from "../helpers/test-db";

describe("exam task admin routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminToken: string;
  let superToken: string;
  let employeeToken: string;
  let bankId: string;
  let employeeIds: string[];

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("RouteExamPass123");
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "ETR-A",
        name: "路由管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
      },
    });
    const superAdmin = await testDb.db.user.create({
      data: {
        employeeNo: "ETR-S",
        name: "路由超管",
        role: Role.SUPER_ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
      },
    });
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "ETR-E0",
        name: "路由员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
        status: UserStatus.ACTIVE,
        enabled: true,
        workLocation: WorkLocation.SHANGHAI,
      },
    });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN }))
      .token;
    superToken = (
      await createSession(testDb.db, superAdmin.id, { viewMode: SessionViewMode.ADMIN })
    ).token;
    employeeToken = (
      await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })
    ).token;

    const bank = await createBlankQuestionBank(testDb.db, {
      name: "路由题库",
      actorId: admin.id,
    });
    bankId = bank.id;
    await createQuestionBankQuestion(
      testDb.db,
      bankId,
      {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "路由题",
        score: 100,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      },
      admin.id,
    );
    await setQuestionBankStatus(testDb.db, bankId, QuestionBankStatus.ENABLED, admin.id);
    await setDefaultQuestionBank(testDb.db, bankId, admin.id);

    employeeIds = [employee.id];
    for (let index = 1; index <= 2; index += 1) {
      const extra = await testDb.db.user.create({
        data: {
          employeeNo: `ETR-E${index}`,
          name: `路由员工${index}`,
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash,
          mustChangePassword: false,
          status: UserStatus.ACTIVE,
          enabled: true,
        },
      });
      employeeIds.push(extra.id);
    }
  });

  afterEach(async () => testDb.cleanup());

  const deps = () => ({ db: testDb.db });
  const request = (url: string, token: string, method = "GET", body?: unknown) =>
    new Request(`http://localhost:3000${url}`, {
      method,
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin: "http://localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("returns selectable banks with default preselection metadata", async () => {
    const route = createAdminExamTaskSelectableBanksRoute(deps());
    const response = await route.GET(
      request("/api/admin/exam-tasks/selectable-banks", adminToken),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      defaultBankId: string;
      banks: Array<{ id: string; isDefault: boolean; enabledScore: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.defaultBankId).toBe(bankId);
    expect(body.banks).toHaveLength(1);
    expect(body.banks[0]?.enabledScore).toBe(100);
  });

  it("does not list an enabled bank whose question answers are invalid", async () => {
    await testDb.db.questionBankOption.updateMany({
      where: { question: { questionBankId: bankId } },
      data: { isCorrect: false },
    });
    const route = createAdminExamTaskSelectableBanksRoute(deps());
    const response = await route.GET(
      request("/api/admin/exam-tasks/selectable-banks", adminToken),
    );
    const body = (await response.json()) as { banks: unknown[]; defaultBankId: string | null };
    expect(body.banks).toEqual([]);
    expect(body.defaultBankId).toBeNull();
  });

  it("allows admin and super admin publish, rejects employees", async () => {
    const route = createAdminExamTasksRoute(deps());
    const payload = {
      idempotencyKey: "route-publish-1", // gitleaks:allow -- deterministic synthetic fixture
      name: "路由发布",
      questionBankId: bankId,
      startsAt: "2026-09-01T01:00:00.000Z",
      endsAt: "2026-09-08T01:00:00.000Z",
      selection: { mode: "EXPLICIT", userIds: employeeIds.slice(0, 2) },
    };

    const forbidden = await route.POST(
      request("/api/admin/exam-tasks", employeeToken, "POST", payload),
    );
    expect(forbidden.status).toBe(403);

    const adminResponse = await route.POST(
      request("/api/admin/exam-tasks", adminToken, "POST", payload),
    );
    expect(adminResponse.status).toBe(201);
    const adminBody = await adminResponse.json();
    expect(adminBody.ok).toBe(true);
    expect(adminBody.task.assignmentCount).toBe(2);
    expect(JSON.stringify(adminBody)).not.toContain("isCorrect");

    const superResponse = await route.POST(
      request("/api/admin/exam-tasks", superToken, "POST", {
        ...payload,
        idempotencyKey: "route-publish-super",
        name: "超管路由发布",
        selection: { mode: "EXPLICIT", userIds: [employeeIds[2]!] },
      }),
    );
    expect(superResponse.status).toBe(201);
  });

  it("returns original task on idempotent replay", async () => {
    const route = createAdminExamTasksRoute(deps());
    const payload = {
      idempotencyKey: "route-idem",
      name: "幂等路由",
      questionBankId: bankId,
      startsAt: "2026-09-01T01:00:00.000Z",
      endsAt: "2026-09-08T01:00:00.000Z",
      selection: { mode: "EXPLICIT", userIds: [employeeIds[0]!] },
    };
    const first = await route.POST(
      request("/api/admin/exam-tasks", adminToken, "POST", payload),
    );
    const firstBody = await first.json();
    const second = await route.POST(
      request("/api/admin/exam-tasks", adminToken, "POST", payload),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.task.id).toBe(firstBody.task.id);
    expect(secondBody.task.replayed).toBe(true);
  });

  it("resolves filter selection counts for the wizard", async () => {
    const route = createAdminExamTaskResolveAssigneesRoute(deps());
    const response = await route.POST(
      request("/api/admin/exam-tasks/resolve-assignees", adminToken, "POST", {
        selection: {
          mode: "FILTER",
          filter: {},
          excludedUserIds: [employeeIds[0]!],
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; total: number };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);

    const denied = await route.POST(
      request("/api/admin/exam-tasks/resolve-assignees", employeeToken, "POST", {
        selection: { mode: "EXPLICIT", userIds: employeeIds },
      }),
    );
    expect(denied.status).toBe(403);
  });
});

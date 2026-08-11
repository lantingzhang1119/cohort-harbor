import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QuestionBankQuestionType,
  QuestionBankStatus,
  Role,
  SessionViewMode,
  UserSource,
} from "@/generated/prisma/enums";
import { createAdminQuestionBanksRoute } from "@/app/api/admin/question-banks/route";
import { createAdminQuestionBankRoute } from "@/app/api/admin/question-banks/[id]/route";
import { createAdminQuestionBankDefaultRoute } from "@/app/api/admin/question-banks/[id]/default/route";
import { createAdminQuestionBankCopyRoute } from "@/app/api/admin/question-banks/[id]/copy/route";
import { createAdminQuestionBankQuestionsRoute } from "@/app/api/admin/question-banks/[id]/questions/route";
import { createAdminQuestionBankQuestionRoute } from "@/app/api/admin/question-banks/[id]/questions/[questionId]/route";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createTestDatabase } from "../helpers/test-db";

describe("question bank admin routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminToken: string;
  let employeeToken: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("RoutesPass123");
    const admin = await testDb.db.user.create({
      data: {
        employeeNo: "QB-A",
        name: "题库路由管理员",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    const employee = await testDb.db.user.create({
      data: {
        employeeNo: "QB-E",
        name: "题库路由员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        mustChangePassword: false,
        passwordHash,
      },
    });
    adminToken = (await createSession(testDb.db, admin.id, { viewMode: SessionViewMode.ADMIN })).token;
    employeeToken = (await createSession(testDb.db, employee.id, { viewMode: SessionViewMode.EMPLOYEE })).token;
  });

  afterEach(async () => testDb.cleanup());

  const deps = () => ({ db: testDb.db });
  const request = (
    url: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) =>
    new Request(`http://localhost:3000${url}`, {
      method,
      headers: {
        cookie: `cohort_harbor_session=${token}`,
        origin: "http://localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("supports list/create/copy/default/question save and includes answers for admins only", async () => {
    const listRoute = createAdminQuestionBanksRoute(deps());
    const createResponse = await listRoute.POST(
      request("/api/admin/question-banks", adminToken, "POST", {
        name: "路由题库",
        description: "路由测试",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { bank: { id: string } };
    const bankId = created.bank.id;

    const questionsRoute = createAdminQuestionBankQuestionsRoute(deps(), bankId);
    const saveResponse = await questionsRoute.POST(
      request(`/api/admin/question-banks/${bankId}/questions`, adminToken, "POST", {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "路由单选",
        score: 100,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }),
    );
    expect(saveResponse.status).toBe(201);
    const saved = (await saveResponse.json()) as {
      question: { id: string; options: Array<{ isCorrect: boolean }> };
    };
    expect(saved.question.options.some((option) => option.isCorrect)).toBe(true);

    const enableRoute = createAdminQuestionBankRoute(deps(), bankId);
    const enableResponse = await enableRoute.PATCH(
      request(`/api/admin/question-banks/${bankId}`, adminToken, "PATCH", {
        status: QuestionBankStatus.ENABLED,
      }),
    );
    expect(enableResponse.status).toBe(200);

    const defaultResponse = await createAdminQuestionBankDefaultRoute(deps(), bankId).POST(
      request(`/api/admin/question-banks/${bankId}/default`, adminToken, "POST", {}),
    );
    expect(defaultResponse.status).toBe(200);

    const copyResponse = await createAdminQuestionBankCopyRoute(deps(), bankId).POST(
      request(`/api/admin/question-banks/${bankId}/copy`, adminToken, "POST", {
        name: "路由复制卷",
      }),
    );
    expect(copyResponse.status).toBe(201);

    const detailResponse = await enableRoute.GET(
      request(`/api/admin/question-banks/${bankId}`, adminToken),
    );
    const detailBody = await detailResponse.json();
    expect(detailBody.ok).toBe(true);
    expect(JSON.stringify(detailBody)).toContain("isCorrect");

    const listResponse = await listRoute.GET(request("/api/admin/question-banks", adminToken));
    const listBody = (await listResponse.json()) as { banks: Array<{ name: string; isDefault: boolean }> };
    expect(listBody.banks.some((bank) => bank.name === "路由题库" && bank.isDefault)).toBe(true);

    const forbidden = await listRoute.GET(request("/api/admin/question-banks", employeeToken));
    expect(forbidden.status).toBe(403);

    await createAdminQuestionBankQuestionRoute(deps(), bankId, saved.question.id).DELETE(
      request(
        `/api/admin/question-banks/${bankId}/questions/${saved.question.id}`,
        adminToken,
        "DELETE",
      ),
    );
  });

  it("rejects enabling bank under 100 points with 400", async () => {
    const listRoute = createAdminQuestionBanksRoute(deps());
    const createResponse = await listRoute.POST(
      request("/api/admin/question-banks", adminToken, "POST", { name: "不足百分" }),
    );
    const bankId = ((await createResponse.json()) as { bank: { id: string } }).bank.id;
    await createAdminQuestionBankQuestionsRoute(deps(), bankId).POST(
      request(`/api/admin/question-banks/${bankId}/questions`, adminToken, "POST", {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "低分题",
        score: 10,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }),
    );
    const enableResponse = await createAdminQuestionBankRoute(deps(), bankId).PATCH(
      request(`/api/admin/question-banks/${bankId}`, adminToken, "PATCH", {
        status: QuestionBankStatus.ENABLED,
      }),
    );
    expect(enableResponse.status).toBe(400);
    await expect(enableResponse.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects updating a question through a different bank URL", async () => {
    const listRoute = createAdminQuestionBanksRoute(deps());
    const first = (await (await listRoute.POST(
      request("/api/admin/question-banks", adminToken, "POST", { name: "题库一" }),
    )).json()) as { bank: { id: string } };
    const second = (await (await listRoute.POST(
      request("/api/admin/question-banks", adminToken, "POST", { name: "题库二" }),
    )).json()) as { bank: { id: string } };

    const created = await createAdminQuestionBankQuestionsRoute(deps(), second.bank.id).POST(
      request(`/api/admin/question-banks/${second.bank.id}/questions`, adminToken, "POST", {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "属于题库二",
        score: 100,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }),
    );
    const questionId = ((await created.json()) as { question: { id: string } }).question.id;
    const mismatched = await createAdminQuestionBankQuestionRoute(
      deps(),
      first.bank.id,
      questionId,
    ).PATCH(
      request(`/api/admin/question-banks/${first.bank.id}/questions/${questionId}`, adminToken, "PATCH", {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "不应被改写",
        score: 100,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      }),
    );
    expect(mismatched.status).toBe(404);
    expect(await testDb.db.questionBankQuestion.findUniqueOrThrow({ where: { id: questionId } }))
      .toMatchObject({ prompt: "属于题库二", questionBankId: second.bank.id });
  });
});

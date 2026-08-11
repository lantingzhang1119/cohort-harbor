import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NotificationType,
  QuestionBankQuestionType,
  QuestionBankStatus,
  Role,
  UserSource,
  UserStatus,
  WorkLocation,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { AuthError } from "@/features/auth/errors";
import { ExamTaskError } from "@/features/exam-tasks/errors";
import { publishExamTask } from "@/features/exam-tasks/publish-service";
import { parseSnapshotQuestions, toEmployeeExamPaper } from "@/features/exam-tasks/dto";
import {
  createBlankQuestionBank,
  setDefaultQuestionBank,
  setQuestionBankStatus,
} from "@/features/question-banks/question-bank-service";
import { createQuestionBankQuestion } from "@/features/question-banks/question-service";
import { createTestDatabase } from "../helpers/test-db";

describe("exam task publish service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let adminId: string;
  let superAdminId: string;
  let bankId: string;
  let employeeIds: string[];

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("ExamTaskPass!23");
    adminId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ET-ADMIN",
          name: "考试管理员",
          role: Role.ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash,
          mustChangePassword: false,
        },
      })
    ).id;
    superAdminId = (
      await testDb.db.user.create({
        data: {
          employeeNo: "ET-SUPER",
          name: "超级管理员",
          role: Role.SUPER_ADMIN,
          sourceType: UserSource.MANUAL,
          passwordHash,
          mustChangePassword: false,
        },
      })
    ).id;

    const bank = await createBlankQuestionBank(testDb.db, {
      name: "默认入职卷",
      actorId: adminId,
    });
    bankId = bank.id;
    await createQuestionBankQuestion(
      testDb.db,
      bankId,
      {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "总部在哪",
        score: 60,
        enabled: true,
        options: [
          { label: "A", text: "上海", isCorrect: true },
          { label: "B", text: "北京", isCorrect: false },
        ],
      },
      adminId,
    );
    await createQuestionBankQuestion(
      testDb.db,
      bankId,
      {
        type: QuestionBankQuestionType.FILL_BLANK,
        prompt: "及格分是____",
        score: 40,
        enabled: true,
        blanks: [{ blankIndex: 0, acceptableAnswers: ["80", "八十分"] }],
      },
      adminId,
    );
    await setQuestionBankStatus(testDb.db, bankId, QuestionBankStatus.ENABLED, adminId);
    await setDefaultQuestionBank(testDb.db, bankId, adminId);

    employeeIds = [];
    for (let index = 1; index <= 3; index += 1) {
      const employee = await testDb.db.user.create({
        data: {
          employeeNo: `ET-E${index}`,
          name: `员工${index}`,
          role: Role.EMPLOYEE,
          sourceType: UserSource.MANUAL,
          passwordHash,
          mustChangePassword: false,
          workLocation: index === 1 ? WorkLocation.SHANGHAI : WorkLocation.SHENZHEN,
          firstDepartment: index === 3 ? "行政部" : "研发中心",
          status: UserStatus.ACTIVE,
          enabled: true,
        },
      });
      employeeIds.push(employee.id);
    }
  });

  afterEach(async () => testDb.cleanup());

  function baseInput(overrides: Record<string, unknown> = {}) {
    const startsAt = new Date("2026-08-01T01:00:00.000Z");
    const endsAt = new Date("2026-08-10T01:00:00.000Z");
    return {
      idempotencyKey: "publish-key-001", // gitleaks:allow -- deterministic synthetic fixture
      name: "八月入职考试",
      description: "请认真作答",
      questionBankId: bankId,
      startsAt,
      endsAt,
      passingScore: 80,
      selection: {
        mode: "EXPLICIT" as const,
        userIds: employeeIds.slice(0, 2),
      },
      ...overrides,
    };
  }

  it("lets admin and super admin publish with default bank validation of 100 points", async () => {
    const byAdmin = await publishExamTask(testDb.db, baseInput(), adminId);
    expect(byAdmin.replayed).toBe(false);
    expect(byAdmin.assignmentCount).toBe(2);
    expect(byAdmin.totalScore).toBe(100);
    expect(byAdmin.questionBankVersion).toBeGreaterThanOrEqual(1);
    expect(byAdmin.passingScore).toBe(80);

    const bySuper = await publishExamTask(
      testDb.db,
      baseInput({
        idempotencyKey: "publish-key-super",
        name: "超管发布",
        selection: { mode: "EXPLICIT", userIds: [employeeIds[2]!] },
      }),
      superAdminId,
    );
    expect(bySuper.assignmentCount).toBe(1);
  });

  it("rejects employee actors at the permission boundary", async () => {
    const employeeActor = employeeIds[0]!;
    await expect(publishExamTask(testDb.db, baseInput(), employeeActor)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("does not leak an existing idempotent task to an employee actor", async () => {
    await publishExamTask(testDb.db, baseInput(), adminId);
    await expect(
      publishExamTask(testDb.db, baseInput(), employeeIds[0]!),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects banks that are not enabled or not exactly 100 points", async () => {
    const draft = await createBlankQuestionBank(testDb.db, {
      name: "草稿卷",
      actorId: adminId,
    });
    await expect(
      publishExamTask(
        testDb.db,
        baseInput({ questionBankId: draft.id, idempotencyKey: "bad-draft" }),
        adminId,
      ),
    ).rejects.toMatchObject({ code: "BANK_NOT_SELECTABLE" });

    await createQuestionBankQuestion(
      testDb.db,
      draft.id,
      {
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "半套",
        score: 40,
        enabled: true,
        options: [
          { label: "A", text: "对", isCorrect: true },
          { label: "B", text: "错", isCorrect: false },
        ],
      },
      adminId,
    );
    await expect(
      publishExamTask(
        testDb.db,
        baseInput({ questionBankId: draft.id, idempotencyKey: "bad-score" }),
        adminId,
      ),
    ).rejects.toMatchObject({ code: "BANK_NOT_SELECTABLE" });
  });

  it("supports EXPLICIT ids and FILTER+excluded selection models", async () => {
    const explicit = await publishExamTask(
      testDb.db,
      baseInput({
        idempotencyKey: "sel-explicit",
        selection: { mode: "EXPLICIT", userIds: [employeeIds[0]!, employeeIds[1]!] },
      }),
      adminId,
    );
    expect(explicit.assignmentCount).toBe(2);

    const filtered = await publishExamTask(
      testDb.db,
      baseInput({
        idempotencyKey: "sel-filter",
        name: "筛选发布",
        selection: {
          mode: "FILTER",
          filter: { department: "研发中心" },
          excludedUserIds: [employeeIds[0]!],
        },
      }),
      adminId,
    );
    expect(filtered.assignmentCount).toBe(1);
    const assignment = await testDb.db.examTaskAssignment.findFirstOrThrow({
      where: { taskId: filtered.id },
    });
    expect(assignment.userId).toBe(employeeIds[1]!);
  });

  it("rejects departed, disabled, non-loginable and non-employee explicit ids", async () => {
    const departed = await testDb.db.user.create({
      data: {
        employeeNo: "ET-LEFT",
        name: "离职员工",
        role: Role.EMPLOYEE,
        status: UserStatus.DEPARTED,
        enabled: false,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("x"),
      },
    });
    await expect(
      publishExamTask(
        testDb.db,
        baseInput({
          idempotencyKey: "reject-left",
          selection: { mode: "EXPLICIT", userIds: [departed.id] },
        }),
        adminId,
      ),
    ).rejects.toMatchObject({ code: "INELIGIBLE_ASSIGNEES" });

    await expect(
      publishExamTask(
        testDb.db,
        baseInput({
          idempotencyKey: "reject-admin",
          selection: { mode: "EXPLICIT", userIds: [adminId] },
        }),
        adminId,
      ),
    ).rejects.toMatchObject({ code: "INELIGIBLE_ASSIGNEES" });
  });

  it("excludes ineligible employees when resolving FILTER selections", async () => {
    await testDb.db.user.update({
      where: { id: employeeIds[1]! },
      data: { enabled: false, status: UserStatus.DISABLED },
    });
    const task = await publishExamTask(
      testDb.db,
      baseInput({
        idempotencyKey: "filter-skip-disabled",
        selection: {
          mode: "FILTER",
          filter: {},
          excludedUserIds: [],
        },
      }),
      adminId,
    );
    const assigned = await testDb.db.examTaskAssignment.findMany({
      where: { taskId: task.id },
      select: { userId: true },
    });
    expect(assigned.map((item) => item.userId).sort()).toEqual(
      [employeeIds[0]!, employeeIds[2]!].sort(),
    );
  });

  it("creates snapshot, assignments, notifications and audit in one publish", async () => {
    const task = await publishExamTask(testDb.db, baseInput(), adminId);
    expect(await testDb.db.examPaperSnapshot.count()).toBe(1);
    expect(await testDb.db.examTaskAssignment.count({ where: { taskId: task.id } })).toBe(2);
    const notifications = await testDb.db.notification.findMany({
      where: { type: NotificationType.EXAM_TASK_PUBLISHED },
    });
    expect(notifications).toHaveLength(2);
    expect(notifications.every((item) => item.examTaskAssignmentId)).toBe(true);
    expect(
      notifications.every(
        (item) => item.href === `/employee/exam?assignmentId=${item.examTaskAssignmentId}`,
      ),
    ).toBe(true);
    expect(notifications.every((item) => item.dedupeKey?.startsWith("exam-task-published:"))).toBe(
      true,
    );
    expect(await testDb.db.auditLog.count({ where: { action: "EXAM_TASK_PUBLISH" } })).toBe(1);
  });

  it("is idempotent for the same key and does not merge different keys", async () => {
    const first = await publishExamTask(testDb.db, baseInput(), adminId);
    const replay = await publishExamTask(testDb.db, baseInput(), adminId);
    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    expect(await testDb.db.examPaperSnapshot.count()).toBe(1);
    expect(await testDb.db.examTaskAssignment.count()).toBe(2);
    expect(await testDb.db.notification.count()).toBe(2);
    expect(await testDb.db.auditLog.count({ where: { action: "EXAM_TASK_PUBLISH" } })).toBe(1);

    const other = await publishExamTask(
      testDb.db,
      baseInput({
        idempotencyKey: "publish-key-002", // gitleaks:allow -- deterministic synthetic fixture
        name: "另一场考试",
      }),
      adminId,
    );
    expect(other.id).not.toBe(first.id);
    expect(await testDb.db.examTask.count()).toBe(2);
    expect(await testDb.db.examPaperSnapshot.count()).toBe(2);
  });

  it("rejects reuse of an idempotency key for a different publish request", async () => {
    await publishExamTask(testDb.db, baseInput(), adminId);
    await expect(
      publishExamTask(testDb.db, baseInput({ name: "篡改后的任务名" }), adminId),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await testDb.db.examTask.count()).toBe(1);
  });

  it("creates only one task when the same publish is submitted concurrently", async () => {
    const results = await Promise.allSettled([
      publishExamTask(testDb.db, baseInput(), adminId),
      publishExamTask(testDb.db, baseInput(), adminId),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const taskIds = results.map((result) =>
      result.status === "fulfilled" ? result.value.id : "rejected",
    );
    expect(new Set(taskIds).size).toBe(1);
    expect(await testDb.db.examTask.count()).toBe(1);
    expect(await testDb.db.examTaskAssignment.count()).toBe(2);
    expect(await testDb.db.notification.count()).toBe(2);
  });

  it("keeps immutable snapshot when the live bank later changes", async () => {
    const task = await publishExamTask(testDb.db, baseInput(), adminId);
    const snapshot = await testDb.db.examPaperSnapshot.findUniqueOrThrow({
      where: { id: task.snapshotId },
    });
    const before = parseSnapshotQuestions(snapshot.questions);
    expect(before[0]?.prompt).toBe("总部在哪");
    expect(before[0]?.options.some((option) => option.isCorrect)).toBe(true);
    expect(before[1]?.blanks[0]?.acceptableAnswers).toContain("80");

    await testDb.db.questionBankQuestion.updateMany({
      where: { questionBankId: bankId },
      data: { prompt: "已篡改题干" },
    });
    await testDb.db.questionBankOption.updateMany({
      where: { question: { questionBankId: bankId } },
      data: { isCorrect: false },
    });

    const after = await testDb.db.examPaperSnapshot.findUniqueOrThrow({
      where: { id: task.snapshotId },
    });
    const frozen = parseSnapshotQuestions(after.questions);
    expect(frozen[0]?.prompt).toBe("总部在哪");
    expect(frozen[0]?.options.some((option) => option.isCorrect)).toBe(true);

    const employeePaper = toEmployeeExamPaper({
      questionBankId: after.questionBankId,
      questionBankName: after.questionBankName,
      questionBankVersion: after.questionBankVersion,
      questions: frozen,
      questionCount: after.questionCount,
      totalScore: after.totalScore,
      passingScore: after.passingScore,
    });
    expect(JSON.stringify(employeePaper)).not.toContain("isCorrect");
    expect(JSON.stringify(employeePaper)).not.toContain("acceptableAnswers");
    expect(JSON.stringify(employeePaper)).not.toContain("八十分");
    expect(employeePaper.questions.every((question) => !("blanks" in question))).toBe(true);
  });

  it("rolls back snapshot, task and assignments when a later write fails", async () => {
    const originalTransaction = testDb.db.$transaction.bind(testDb.db);
    testDb.db.$transaction = (async (arg: unknown, options?: unknown) => {
      if (typeof arg !== "function") {
        return originalTransaction(arg as never, options as never);
      }
      return originalTransaction(async (transaction) => {
        const originalCreateMany = transaction.notification.createMany.bind(
          transaction.notification,
        );
        transaction.notification.createMany = (async () => {
          throw new Error("notify-fail");
        }) as typeof transaction.notification.createMany;
        try {
          return await (arg as (tx: typeof transaction) => Promise<unknown>)(transaction);
        } finally {
          transaction.notification.createMany = originalCreateMany;
        }
      }, options as never);
    }) as typeof testDb.db.$transaction;

    await expect(publishExamTask(testDb.db, baseInput(), adminId)).rejects.toThrow("notify-fail");
    expect(await testDb.db.examPaperSnapshot.count()).toBe(0);
    expect(await testDb.db.examTask.count()).toBe(0);
    expect(await testDb.db.examTaskAssignment.count()).toBe(0);
    expect(await testDb.db.notification.count()).toBe(0);
    expect(await testDb.db.auditLog.count({ where: { action: "EXAM_TASK_PUBLISH" } })).toBe(0);
  });

  it("rejects startsAt >= endsAt and defaults passing score to 80", async () => {
    await expect(
      publishExamTask(
        testDb.db,
        baseInput({
          idempotencyKey: "bad-time",
          startsAt: new Date("2026-08-10T00:00:00.000Z"),
          endsAt: new Date("2026-08-01T00:00:00.000Z"),
        }),
        adminId,
      ),
    ).rejects.toBeInstanceOf(ExamTaskError);

    const task = await publishExamTask(
      testDb.db,
      {
        idempotencyKey: "default-pass",
        name: "默认及格分",
        questionBankId: bankId,
        startsAt: new Date("2026-08-01T01:00:00.000Z"),
        endsAt: new Date("2026-08-10T01:00:00.000Z"),
        selection: { mode: "EXPLICIT", userIds: [employeeIds[0]!] },
      } as never,
      adminId,
    );
    expect(task.passingScore).toBe(80);
  });
});

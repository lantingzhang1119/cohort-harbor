import {
  QuestionBankQuestionType,
  QuestionBankStatus,
  Role,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { publishExamTask } from "@/features/exam-tasks/publish-service";
import {
  createBlankQuestionBank,
  setQuestionBankStatus,
} from "@/features/question-banks/question-bank-service";
import { createQuestionBankQuestion } from "@/features/question-banks/question-service";
import { createTestDatabase } from "./test-db";

export async function createExamTaskFixture(options: {
  startsAt?: Date;
  endsAt?: Date;
  employeeCount?: number;
} = {}) {
  const testDb = await createTestDatabase();
  const passwordHash = await hashPassword("RuntimePass123");
  const admin = await testDb.db.user.create({
    data: {
      employeeNo: "RT-ADMIN",
      name: "运行时管理员",
      role: Role.ADMIN,
      sourceType: UserSource.MANUAL,
      passwordHash,
      mustChangePassword: false,
    },
  });
  const employees = [];
  for (let index = 0; index < (options.employeeCount ?? 2); index += 1) {
    employees.push(await testDb.db.user.create({
      data: {
        employeeNo: `RT-E${index + 1}`,
        name: `运行时员工${index + 1}`,
        role: Role.EMPLOYEE,
        status: UserStatus.ACTIVE,
        enabled: true,
        sourceType: UserSource.MANUAL,
        passwordHash,
        mustChangePassword: false,
      },
    }));
  }
  const bank = await createBlankQuestionBank(testDb.db, {
    name: "运行时试卷",
    actorId: admin.id,
  });
  const choice = await createQuestionBankQuestion(
    testDb.db,
    bank.id,
    {
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "总部在哪里？",
      score: 40,
      enabled: true,
      options: [
        { label: "A", text: "上海", isCorrect: true },
        { label: "B", text: "北京", isCorrect: false },
      ],
    },
    admin.id,
  );
  const fill = await createQuestionBankQuestion(
    testDb.db,
    bank.id,
    {
      type: QuestionBankQuestionType.FILL_BLANK,
      prompt: "城市____，分数____",
      score: 60,
      enabled: true,
      blanks: [
        { blankIndex: 0, acceptableAnswers: ["上海", "SHANGHAI"] },
        { blankIndex: 1, acceptableAnswers: ["80分"] },
      ],
    },
    admin.id,
  );
  await setQuestionBankStatus(testDb.db, bank.id, QuestionBankStatus.ENABLED, admin.id);
  const task = await publishExamTask(
    testDb.db,
    {
      idempotencyKey: `runtime-${Math.random().toString(36).slice(2)}`,
      name: "运行时任务",
      questionBankId: bank.id,
      startsAt: options.startsAt ?? new Date("2026-08-01T00:00:00.000Z"),
      endsAt: options.endsAt ?? new Date("2026-08-10T00:00:00.000Z"),
      passingScore: 80,
      selection: { mode: "EXPLICIT", userIds: employees.map((employee) => employee.id) },
    },
    admin.id,
  );
  const assignments = await testDb.db.examTaskAssignment.findMany({
    where: { taskId: task.id },
    orderBy: { userId: "asc" },
  });
  return { testDb, admin, employees, bank, choice, fill, task, assignments };
}

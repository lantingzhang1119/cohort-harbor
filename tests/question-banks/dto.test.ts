import { describe, expect, it } from "vitest";

import { QuestionBankQuestionType, QuestionBankSource, QuestionBankStatus } from "@/generated/prisma/enums";
import {
  toAdminQuestionBankDetail,
  toAdminQuestionDto,
  toEmployeeQuestionDto,
  toEmployeeQuestionBankPaper,
} from "@/features/question-banks/dto";

const sampleQuestion = {
  id: "q1",
  questionBankId: "b1",
  sequence: 1,
  type: QuestionBankQuestionType.SINGLE_CHOICE,
  prompt: "题干",
  score: 10,
  enabled: true,
  createdAt: new Date("2026-07-28T00:00:00.000Z"),
  updatedAt: new Date("2026-07-28T00:00:00.000Z"),
  options: [
    { id: "o1", questionId: "q1", label: "A", text: "对", isCorrect: true, sortOrder: 0 },
    { id: "o2", questionId: "q1", label: "B", text: "错", isCorrect: false, sortOrder: 1 },
  ],
  blankAnswers: [] as Array<{
    id: string;
    questionId: string;
    blankIndex: number;
    acceptableAnswers: unknown;
    sortOrder: number;
  }>,
};

const fillBlankQuestion = {
  ...sampleQuestion,
  id: "q2",
  type: QuestionBankQuestionType.FILL_BLANK,
  options: [],
  blankAnswers: [
    {
      id: "ba1",
      questionId: "q2",
      blankIndex: 0,
      acceptableAnswers: ["上海", "SH"],
      sortOrder: 0,
    },
  ],
};

describe("question bank DTOs", () => {
  it("admin DTO includes correctness and acceptable answers", () => {
    const admin = toAdminQuestionDto(sampleQuestion);
    expect(admin.options[0]).toMatchObject({ label: "A", isCorrect: true });
    const adminFill = toAdminQuestionDto(fillBlankQuestion);
    expect(adminFill.blanks?.[0]?.acceptableAnswers).toEqual(["上海", "SH"]);
  });

  it("employee DTO never exposes isCorrect or acceptable answers", () => {
    const employee = toEmployeeQuestionDto(sampleQuestion);
    expect(employee).toMatchObject({
      id: "q1",
      type: QuestionBankQuestionType.SINGLE_CHOICE,
      prompt: "题干",
      score: 10,
    });
    expect(employee.options[0]).toEqual({ id: "o1", label: "A", text: "对" });
    expect(JSON.stringify(employee)).not.toContain("isCorrect");
    expect(JSON.stringify(employee)).not.toContain("correct");

    const employeeFill = toEmployeeQuestionDto(fillBlankQuestion);
    expect(employeeFill.blankCount).toBe(1);
    expect(JSON.stringify(employeeFill)).not.toContain("上海");
    expect(JSON.stringify(employeeFill)).not.toContain("acceptableAnswers");
    expect(JSON.stringify(employeeFill)).not.toContain("isCorrect");
  });

  it("employee paper omits answers while admin detail keeps them", () => {
    const bank = {
      id: "b1",
      name: "试卷",
      description: null,
      isDefault: true,
      status: QuestionBankStatus.ENABLED,
      source: QuestionBankSource.ONLINE,
      versionNumber: 1,
      enabledScore: 10,
      questionCount: 1,
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      updatedAt: new Date("2026-07-28T00:00:00.000Z"),
      createdBySnapshot: { name: "管理员" },
      updatedBySnapshot: { name: "管理员" },
      questions: [sampleQuestion, fillBlankQuestion],
    };
    const admin = toAdminQuestionBankDetail(bank);
    expect(admin.questions[0]!.options[0]).toHaveProperty("isCorrect", true);
    expect(admin.questions[1]!.blanks?.[0]?.acceptableAnswers).toContain("上海");

    const employee = toEmployeeQuestionBankPaper(bank);
    expect(JSON.stringify(employee)).not.toContain("isCorrect");
    expect(JSON.stringify(employee)).not.toContain("acceptableAnswers");
    expect(JSON.stringify(employee)).not.toContain("上海");
  });
});

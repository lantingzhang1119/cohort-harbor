import { describe, expect, it } from "vitest";

import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import {
  parseSnapshotQuestions,
  toEmployeeExamPaper,
  type ExamPaperSnapshotPayload,
} from "@/features/exam-tasks/dto";

describe("exam task dto isolation", () => {
  const payload: ExamPaperSnapshotPayload = {
    questionBankId: "bank-1",
    questionBankName: "入职卷",
    questionBankVersion: 3,
    questionCount: 2,
    totalScore: 100,
    passingScore: 80,
    questions: [
      {
        id: "q1",
        sequence: 1,
        type: QuestionBankQuestionType.SINGLE_CHOICE,
        prompt: "单选",
        score: 60,
        options: [
          { id: "o1", label: "A", text: "对", isCorrect: true, sortOrder: 0 },
          { id: "o2", label: "B", text: "错", isCorrect: false, sortOrder: 1 },
        ],
        blanks: [],
      },
      {
        id: "q2",
        sequence: 2,
        type: QuestionBankQuestionType.FILL_BLANK,
        prompt: "填空",
        score: 40,
        options: [],
        blanks: [
          {
            id: "b1",
            blankIndex: 0,
            acceptableAnswers: ["答案A", "答案B"],
            sortOrder: 0,
          },
        ],
      },
    ],
  };

  it("strips correct answers from employee paper DTOs", () => {
    const paper = toEmployeeExamPaper(payload);
    const serialized = JSON.stringify(paper);
    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("acceptableAnswers");
    expect(serialized).not.toContain("答案A");
    expect(paper.questions[0]?.options).toEqual([
      { id: "o1", label: "A", text: "对" },
      { id: "o2", label: "B", text: "错" },
    ]);
    expect(paper.questions[1]?.blankCount).toBe(1);
  });

  it("round-trips snapshot JSON with answers for backend only", () => {
    const parsed = parseSnapshotQuestions(payload.questions as never);
    expect(parsed[0]?.options[0]?.isCorrect).toBe(true);
    expect(parsed[1]?.blanks[0]?.acceptableAnswers).toEqual(["答案A", "答案B"]);
  });
});

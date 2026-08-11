import { describe, expect, it } from "vitest";

import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { scoreTaskResponses } from "@/features/exam-task-runtime/scoring";
import type { StoredSnapshotQuestion } from "@/features/exam-task-runtime/types";

const questions: StoredSnapshotQuestion[] = [
  {
    id: "single",
    sequence: 1,
    type: QuestionBankQuestionType.SINGLE_CHOICE,
    prompt: "单选",
    score: 30,
    options: [
      { id: "s-a", label: "A", text: "A", isCorrect: true, sortOrder: 0 },
      { id: "s-b", label: "B", text: "B", isCorrect: false, sortOrder: 1 },
    ],
    blanks: [],
  },
  {
    id: "multi",
    sequence: 2,
    type: QuestionBankQuestionType.MULTIPLE_CHOICE,
    prompt: "多选",
    score: 30,
    options: [
      { id: "m-a", label: "A", text: "A", isCorrect: true, sortOrder: 0 },
      { id: "m-b", label: "B", text: "B", isCorrect: true, sortOrder: 1 },
      { id: "m-c", label: "C", text: "C", isCorrect: false, sortOrder: 2 },
    ],
    blanks: [],
  },
  {
    id: "fill",
    sequence: 3,
    type: QuestionBankQuestionType.FILL_BLANK,
    prompt: "填空",
    score: 40,
    options: [],
    blanks: [
      { id: "b1", blankIndex: 0, acceptableAnswers: ["上海", "SHANGHAI"], sortOrder: 0 },
      { id: "b2", blankIndex: 1, acceptableAnswers: ["80分"], sortOrder: 1 },
    ],
  },
];

describe("exam task snapshot scoring", () => {
  it("scores all-or-nothing choices and normalized multi-blank answers", () => {
    const result = scoreTaskResponses(
      questions,
      {
        single: { selectedOptionIds: ["s-a"] },
        multi: { selectedOptionIds: ["m-b", "m-a"] },
        fill: { values: ["ＳＨＡＮＧＨＡＩ", " 80，分 "] },
      },
      80,
    );
    expect(result).toEqual({
      score: 100,
      passed: true,
      awarded: { single: 30, multi: 30, fill: 40 },
    });
  });

  it("does not partially score a multi-choice or multi-blank question", () => {
    const result = scoreTaskResponses(
      questions,
      {
        single: { selectedOptionIds: ["s-b"] },
        multi: { selectedOptionIds: ["m-a"] },
        fill: { values: ["上海", "错误"] },
      },
      80,
    );
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});

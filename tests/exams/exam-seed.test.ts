import { describe, expect, it } from "vitest";

import { QuestionType } from "@/generated/prisma/enums";
import { mockOnboardingQuestions } from "@/features/exams/exam-seed-data";

describe("public onboarding seed", () => {
  it("contains the exact 23-question, 100-point structure", () => {
    expect(mockOnboardingQuestions).toHaveLength(23);
    expect(mockOnboardingQuestions.map((question) => question.sequence)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 1),
    );
    expect(mockOnboardingQuestions.filter((question) => question.type === QuestionType.SINGLE)).toHaveLength(8);
    expect(mockOnboardingQuestions.filter((question) => question.type === QuestionType.TRUE_FALSE)).toHaveLength(8);
    expect(mockOnboardingQuestions.filter((question) => question.type === QuestionType.MULTIPLE)).toHaveLength(7);
    expect(mockOnboardingQuestions.reduce((total, question) => total + question.score, 0)).toBe(100);
  });

  it("has valid unique options and correct keys for every question", () => {
    for (const question of mockOnboardingQuestions) {
      const keys = question.options.map((option) => option.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(question.correctKeys.length).toBeGreaterThan(0);
      expect(question.correctKeys.every((key) => keys.includes(key))).toBe(true);
      if (question.type !== QuestionType.MULTIPLE) {
        expect(question.correctKeys).toHaveLength(1);
      }
    }
  });
});

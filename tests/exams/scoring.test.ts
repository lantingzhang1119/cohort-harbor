import { describe, expect, it } from "vitest";

import { scoreAnswers } from "@/features/exams/scoring";

describe("scoreAnswers", () => {
  const questions = [
    { questionId: "single", score: 40, correctKeys: ["B"] },
    { questionId: "multiple", score: 40, correctKeys: ["A", "C"] },
    { questionId: "judgment", score: 20, correctKeys: ["A"] },
  ];

  it("scores single/judgment and requires an exact multiple-choice set", () => {
    expect(scoreAnswers(questions, { single: ["B"], multiple: ["C", "A"], judgment: ["A"] })).toEqual({ score: 100, passed: true, awarded: { single: 40, multiple: 40, judgment: 20 } });
    expect(scoreAnswers(questions, { single: ["B"], multiple: ["A"], judgment: ["A"] }).score).toBe(60);
    expect(scoreAnswers(questions, { single: ["B"], multiple: ["A", "B", "C"], judgment: ["A"] }).score).toBe(60);
  });

  it.each([
    [79, false],
    [80, true],
    [100, true],
  ])("uses 80 as the passing boundary for %i", (score, passed) => {
    expect(scoreAnswers([{ questionId: "q", score, correctKeys: ["A"] }], { q: ["A"] }, 80).passed).toBe(passed);
  });
});

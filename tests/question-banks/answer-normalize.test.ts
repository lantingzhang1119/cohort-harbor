import { describe, expect, it } from "vitest";

import {
  matchesAnyAcceptableAnswer,
  normalizeAnswer,
  scoreFillBlankAnswer,
} from "@/features/question-banks/answer-normalize";

describe("normalizeAnswer", () => {
  it("converts nullish values to empty string", () => {
    expect(normalizeAnswer(null)).toBe("");
    expect(normalizeAnswer(undefined)).toBe("");
  });

  it("applies unicode NFC and removes superfluous whitespace", () => {
    expect(normalizeAnswer("  海  栎\u0041\u030A 创  ")).toBe(normalizeAnswer("海栎Å创"));
    expect(normalizeAnswer("a   b\tc\nd")).toBe("abcd");
  });

  it("normalizes full-width/half-width latin letters, digits and spaces", () => {
    expect(normalizeAnswer("ＡｂＣ１２３")).toBe(normalizeAnswer("AbC123"));
    expect(normalizeAnswer("全角　空格")).toBe(normalizeAnswer("全角空格"));
  });

  it("lowercases English letters without changing Chinese characters", () => {
    expect(normalizeAnswer("Hello世界")).toBe("hello世界");
    expect(normalizeAnswer("HELLO")).toBe("hello");
  });

  it("ignores common Chinese and English punctuation differences", () => {
    expect(normalizeAnswer("是的！")).toBe(normalizeAnswer("是的"));
    expect(normalizeAnswer("ok.")).toBe(normalizeAnswer("ok"));
    expect(normalizeAnswer("（答案）")).toBe(normalizeAnswer("(答案)"));
    expect(normalizeAnswer("A、B")).toBe(normalizeAnswer("AB"));
    expect(normalizeAnswer("yes, please")).toBe(normalizeAnswer("yesplease"));
  });

  it("does not treat completely different answers as equal", () => {
    expect(normalizeAnswer("上海")).not.toBe(normalizeAnswer("深圳"));
    expect(normalizeAnswer("true")).not.toBe(normalizeAnswer("false"));
    expect(normalizeAnswer("100")).not.toBe(normalizeAnswer("1000"));
    expect(normalizeAnswer("C++")).not.toBe(normalizeAnswer("C"));
    expect(normalizeAnswer("C#")).not.toBe(normalizeAnswer("C"));
    expect(normalizeAnswer("50%")).not.toBe(normalizeAnswer("50"));
    expect(normalizeAnswer("R&D")).not.toBe(normalizeAnswer("RD"));
  });
});

describe("matchesAnyAcceptableAnswer", () => {
  it("matches when employee answer equals any acceptable answer after normalization", () => {
    const acceptable = ["上海", "SHANGHAI", "Shang Hai"];
    expect(matchesAnyAcceptableAnswer("  上  海！ ", acceptable)).toBe(true);
    expect(matchesAnyAcceptableAnswer("shanghai", acceptable)).toBe(true);
    expect(matchesAnyAcceptableAnswer("Ｓｈａｎｇ　Ｈａｉ", acceptable)).toBe(true);
    expect(matchesAnyAcceptableAnswer("北京", acceptable)).toBe(false);
  });
});

describe("scoreFillBlankAnswer", () => {
  it("awards full score only when every blank matches an acceptable answer", () => {
    const blanks = [
      { blankIndex: 0, acceptableAnswers: ["上海", "SH"] },
      { blankIndex: 1, acceptableAnswers: ["80", "八十"] },
    ];
    expect(scoreFillBlankAnswer(blanks, ["上海", "80"], 10)).toEqual({ correct: true, awarded: 10 });
    expect(scoreFillBlankAnswer(blanks, ["SH", "八十"], 10)).toEqual({ correct: true, awarded: 10 });
    expect(scoreFillBlankAnswer(blanks, ["上海", "70"], 10)).toEqual({ correct: false, awarded: 0 });
    expect(scoreFillBlankAnswer(blanks, ["上海"], 10)).toEqual({ correct: false, awarded: 0 });
  });
});

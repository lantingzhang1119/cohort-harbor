/**
 * Shared answer normalization for fill-blank editing validation and exam scoring.
 * Do not reimplement this logic in pages or ad-hoc helpers.
 */

const FULL_WIDTH_SPACE = "\u3000";

/** Common Chinese / English punctuation stripped after width and case normalization. */
const PUNCTUATION_PATTERN =
  /[，。！？；：、,.!?;:（）()【】\[\]《》<>「」『』“”‘’"'`·•…\-—–_~～]/gu;

function toHalfWidth(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x3000) {
      result += " ";
      continue;
    }
    // Full-width ASCII range ！(FF01) through ～(FF5E) → half-width.
    if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCodePoint(code - 0xfee0);
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Normalize an answer for comparison.
 * Order: null-safe → Unicode NFC → full/half width → strip whitespace → lower case → strip punctuation.
 * All whitespace (including internal) is treated as superfluous for fill-blank matching.
 */
export function normalizeAnswer(raw: unknown): string {
  if (raw == null) return "";
  let value = String(raw);
  value = value.normalize("NFC");
  value = toHalfWidth(value).replaceAll(FULL_WIDTH_SPACE, " ");
  value = value.replace(/\s+/gu, "");
  value = value.toLowerCase();
  value = value.replace(PUNCTUATION_PATTERN, "");
  return value;
}

export function matchesAnyAcceptableAnswer(answer: unknown, acceptableAnswers: readonly unknown[]): boolean {
  const normalized = normalizeAnswer(answer);
  if (!acceptableAnswers.length) return false;
  return acceptableAnswers.some((item) => normalizeAnswer(item) === normalized);
}

export type FillBlankSpec = {
  blankIndex: number;
  acceptableAnswers: readonly unknown[];
};

export function scoreFillBlankAnswer(
  blanks: readonly FillBlankSpec[],
  answers: readonly unknown[],
  score: number,
): { correct: boolean; awarded: number } {
  const ordered = [...blanks].sort((left, right) => left.blankIndex - right.blankIndex);
  if (!ordered.length || answers.length !== ordered.length) {
    return { correct: false, awarded: 0 };
  }
  const correct = ordered.every((blank, index) =>
    matchesAnyAcceptableAnswer(answers[index], blank.acceptableAnswers),
  );
  return { correct, awarded: correct ? score : 0 };
}

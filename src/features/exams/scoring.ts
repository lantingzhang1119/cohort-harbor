export type ScoringQuestion = {
  questionId: string;
  score: number;
  correctKeys: string[];
};

function normalized(keys: string[] | undefined) {
  return [...new Set(keys ?? [])].map((key) => key.trim().toUpperCase()).sort();
}

export function scoreAnswers(
  questions: ScoringQuestion[],
  answers: Record<string, string[]>,
  passingScore = 80,
) {
  const awarded: Record<string, number> = {};
  let score = 0;
  for (const question of questions) {
    const selected = normalized(answers[question.questionId]);
    const correct = normalized(question.correctKeys);
    const matches =
      selected.length === correct.length &&
      selected.every((key, index) => key === correct[index]);
    awarded[question.questionId] = matches ? question.score : 0;
    score += awarded[question.questionId]!;
  }
  return { score, passed: score >= passingScore, awarded };
}

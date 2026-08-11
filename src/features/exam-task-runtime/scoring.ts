import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import { scoreFillBlankAnswer } from "@/features/question-banks/answer-normalize";
import type {
  StoredSnapshotQuestion,
  TaskAnswerResponse,
} from "@/features/exam-task-runtime/types";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function scoreTaskResponses(
  questions: readonly StoredSnapshotQuestion[],
  responses: Readonly<Record<string, TaskAnswerResponse | undefined>>,
  passingScore: number,
) {
  const awarded: Record<string, number> = {};
  let score = 0;
  for (const question of questions) {
    const response = responses[question.id];
    let questionScore = 0;
    if (question.type === QuestionBankQuestionType.FILL_BLANK) {
      const values = response && "values" in response ? response.values : [];
      questionScore = scoreFillBlankAnswer(question.blanks, values, question.score).awarded;
    } else {
      const selected = sortedUnique(
        response && "selectedOptionIds" in response ? response.selectedOptionIds : [],
      );
      const correct = sortedUnique(
        question.options.filter((option) => option.isCorrect).map((option) => option.id),
      );
      const matches =
        selected.length === correct.length &&
        selected.every((value, index) => value === correct[index]);
      questionScore = matches ? question.score : 0;
    }
    awarded[question.id] = questionScore;
    score += questionScore;
  }
  return { score, passed: score >= passingScore, awarded };
}

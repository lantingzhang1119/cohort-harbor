import type { QuestionBankQuestionType } from "@/generated/prisma/enums";

export type StoredSnapshotOption = {
  id: string;
  label: string;
  text: string;
  isCorrect: boolean;
  sortOrder: number;
};

export type StoredSnapshotBlank = {
  id: string;
  blankIndex: number;
  acceptableAnswers: string[];
  sortOrder: number;
};

export type StoredSnapshotQuestion = {
  id: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: StoredSnapshotOption[];
  blanks: StoredSnapshotBlank[];
};

export type ChoiceResponse = { selectedOptionIds: string[] };
export type FillResponse = { values: string[] };
export type TaskAnswerResponse = ChoiceResponse | FillResponse;

export type SafeTaskQuestion = {
  id: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: Array<{ id: string; label: string; text: string }>;
  blankCount: number;
};

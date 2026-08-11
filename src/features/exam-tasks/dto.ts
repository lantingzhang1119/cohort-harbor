import type { Prisma } from "@/generated/prisma/client";
import type {
  AssignmentStatus,
  ExamTaskStatus,
  QuestionBankQuestionType,
  QuestionBankStatus,
} from "@/generated/prisma/enums";

export type SnapshotOption = {
  id: string;
  label: string;
  text: string;
  isCorrect: boolean;
  sortOrder: number;
};

export type SnapshotBlank = {
  id: string;
  blankIndex: number;
  acceptableAnswers: string[];
  sortOrder: number;
};

export type SnapshotQuestion = {
  id: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: SnapshotOption[];
  blanks: SnapshotBlank[];
};

export type ExamPaperSnapshotPayload = {
  questionBankId: string;
  questionBankName: string;
  questionBankVersion: number;
  questions: SnapshotQuestion[];
  questionCount: number;
  totalScore: number;
  passingScore: number;
};

/** Employee-facing paper — never includes isCorrect or acceptable answers. */
export type EmployeeSnapshotOption = {
  id: string;
  label: string;
  text: string;
};

export type EmployeeSnapshotQuestion = {
  id: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: EmployeeSnapshotOption[];
  blankCount: number;
};

export type EmployeeExamPaperDto = {
  questionBankId: string;
  questionBankName: string;
  questionBankVersion: number;
  questionCount: number;
  totalScore: number;
  passingScore: number;
  questions: EmployeeSnapshotQuestion[];
};

export type SelectableQuestionBankDto = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: QuestionBankStatus;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  updatedAt: string;
};

export type AssigneeSummaryDto = {
  id: string;
  employeeNo: string;
  name: string;
  firstDepartment: string | null;
  workLocation: string;
};

export type ResolveAssigneesResultDto = {
  total: number;
  employees: AssigneeSummaryDto[];
};

export type AdminExamTaskDto = {
  id: string;
  name: string;
  description: string | null;
  questionBankId: string;
  snapshotId: string;
  startsAt: string;
  endsAt: string;
  passingScore: number;
  status: ExamTaskStatus;
  publishedAt: string;
  assignmentCount: number;
  questionBankName: string;
  questionBankVersion: number;
  questionCount: number;
  totalScore: number;
  replayed: boolean;
};

export type AdminExamTaskAssignmentDto = {
  id: string;
  userId: string;
  status: AssignmentStatus;
  employeeNo: string;
  name: string;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

export function toEmployeeExamPaper(payload: ExamPaperSnapshotPayload): EmployeeExamPaperDto {
  return {
    questionBankId: payload.questionBankId,
    questionBankName: payload.questionBankName,
    questionBankVersion: payload.questionBankVersion,
    questionCount: payload.questionCount,
    totalScore: payload.totalScore,
    passingScore: payload.passingScore,
    questions: payload.questions
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((question) => ({
        id: question.id,
        sequence: question.sequence,
        type: question.type,
        prompt: question.prompt,
        score: question.score,
        options: question.options
          .slice()
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((option) => ({
            id: option.id,
            label: option.label,
            text: option.text,
          })),
        blankCount: question.blanks.length,
      })),
  };
}

export function parseSnapshotQuestions(value: Prisma.JsonValue): SnapshotQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const question = raw as Record<string, unknown>;
    const options = Array.isArray(question.options) ? question.options : [];
    const blanks = Array.isArray(question.blanks) ? question.blanks : [];
    return {
      id: String(question.id ?? ""),
      sequence: Number(question.sequence ?? 0),
      type: question.type as QuestionBankQuestionType,
      prompt: String(question.prompt ?? ""),
      score: Number(question.score ?? 0),
      options: options.map((item) => {
        const option = item as Record<string, unknown>;
        return {
          id: String(option.id ?? ""),
          label: String(option.label ?? ""),
          text: String(option.text ?? ""),
          isCorrect: Boolean(option.isCorrect),
          sortOrder: Number(option.sortOrder ?? 0),
        };
      }),
      blanks: blanks.map((item) => {
        const blank = item as Record<string, unknown>;
        return {
          id: String(blank.id ?? ""),
          blankIndex: Number(blank.blankIndex ?? 0),
          acceptableAnswers: asStringArray(blank.acceptableAnswers),
          sortOrder: Number(blank.sortOrder ?? 0),
        };
      }),
    };
  });
}

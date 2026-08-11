import type { Prisma } from "@/generated/prisma/client";
import type {
  QuestionBankQuestionType,
  QuestionBankSource,
  QuestionBankStatus,
} from "@/generated/prisma/enums";

export type QuestionOptionRecord = {
  id: string;
  questionId: string;
  label: string;
  text: string;
  isCorrect: boolean;
  sortOrder: number;
};

export type QuestionBlankRecord = {
  id: string;
  questionId: string;
  blankIndex: number;
  acceptableAnswers: unknown;
  sortOrder: number;
};

export type QuestionRecord = {
  id: string;
  questionBankId: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  options: QuestionOptionRecord[];
  blankAnswers: QuestionBlankRecord[];
};

export type QuestionBankRecord = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: QuestionBankStatus;
  source: QuestionBankSource;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  createdAt: Date;
  updatedAt: Date;
  createdBySnapshot: Prisma.JsonValue;
  updatedBySnapshot: Prisma.JsonValue;
  questions?: QuestionRecord[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

export type AdminQuestionOptionDto = {
  id: string;
  label: string;
  text: string;
  isCorrect: boolean;
  sortOrder: number;
};

export type AdminQuestionBlankDto = {
  id: string;
  blankIndex: number;
  acceptableAnswers: string[];
  sortOrder: number;
};

export type AdminQuestionDto = {
  id: string;
  questionBankId: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  enabled: boolean;
  options: AdminQuestionOptionDto[];
  blanks: AdminQuestionBlankDto[];
  createdAt: string;
  updatedAt: string;
};

export type EmployeeQuestionOptionDto = {
  id: string;
  label: string;
  text: string;
};

export type EmployeeQuestionDto = {
  id: string;
  sequence: number;
  type: QuestionBankQuestionType;
  prompt: string;
  score: number;
  options: EmployeeQuestionOptionDto[];
  /** Number of blanks for FILL_BLANK; never includes acceptable answers. */
  blankCount: number;
};

export type AdminQuestionBankListItemDto = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: QuestionBankStatus;
  source: QuestionBankSource;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  createdByName: string | null;
  updatedAt: string;
  createdAt: string;
};

export type AdminQuestionBankDetailDto = AdminQuestionBankListItemDto & {
  questions: AdminQuestionDto[];
};

export type EmployeeQuestionBankPaperDto = {
  id: string;
  name: string;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  questions: EmployeeQuestionDto[];
};

function creatorName(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const name = (snapshot as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

export function toAdminQuestionDto(question: QuestionRecord): AdminQuestionDto {
  return {
    id: question.id,
    questionBankId: question.questionBankId,
    sequence: question.sequence,
    type: question.type,
    prompt: question.prompt,
    score: question.score,
    enabled: question.enabled,
    options: question.options
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((option) => ({
        id: option.id,
        label: option.label,
        text: option.text,
        isCorrect: option.isCorrect,
        sortOrder: option.sortOrder,
      })),
    blanks: question.blankAnswers
      .slice()
      .sort((left, right) => left.blankIndex - right.blankIndex)
      .map((blank) => ({
        id: blank.id,
        blankIndex: blank.blankIndex,
        acceptableAnswers: asStringArray(blank.acceptableAnswers),
        sortOrder: blank.sortOrder,
      })),
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}

/** Employee-facing question DTO — never includes isCorrect or acceptable answers. */
export function toEmployeeQuestionDto(question: QuestionRecord): EmployeeQuestionDto {
  return {
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
    blankCount: question.blankAnswers.length,
  };
}

export function toAdminQuestionBankListItem(bank: QuestionBankRecord): AdminQuestionBankListItemDto {
  return {
    id: bank.id,
    name: bank.name,
    description: bank.description,
    isDefault: bank.isDefault,
    status: bank.status,
    source: bank.source,
    versionNumber: bank.versionNumber,
    enabledScore: bank.enabledScore,
    questionCount: bank.questionCount,
    createdByName: creatorName(bank.createdBySnapshot),
    updatedAt: bank.updatedAt.toISOString(),
    createdAt: bank.createdAt.toISOString(),
  };
}

export function toAdminQuestionBankDetail(
  bank: QuestionBankRecord & { questions: QuestionRecord[] },
): AdminQuestionBankDetailDto {
  return {
    ...toAdminQuestionBankListItem(bank),
    questions: bank.questions
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map(toAdminQuestionDto),
  };
}

export function toEmployeeQuestionBankPaper(
  bank: QuestionBankRecord & { questions: QuestionRecord[] },
): EmployeeQuestionBankPaperDto {
  return {
    id: bank.id,
    name: bank.name,
    versionNumber: bank.versionNumber,
    enabledScore: bank.enabledScore,
    questionCount: bank.questionCount,
    questions: bank.questions
      .filter((question) => question.enabled)
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map(toEmployeeQuestionDto),
  };
}

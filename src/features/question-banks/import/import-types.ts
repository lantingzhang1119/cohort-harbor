import type { QuestionBankQuestionType, QuestionBankSource } from "@/generated/prisma/enums";

export type ImportStage =
  | "VALIDATING"
  | "STORING"
  | "EXTRACTING"
  | "OCR"
  | "PARSING"
  | "DRAFTING"
  | "INTEGRITY_CHECK"
  | "REVIEW"
  | "CONFIRMING"
  | "DONE"
  | "FAILED";

export type ImportParseMode = "TEMPLATE" | "BEST_EFFORT";

export type ImportWarning = {
  code: string;
  message: string;
  questionIndex?: number;
  fragmentId?: string;
};

export type SourceFragment = {
  id: string;
  page?: number;
  text: string;
  startOffset?: number;
  endOffset?: number;
};

export type DraftOption = {
  label: string;
  text: string;
  /** null means uncertain — must be reviewed; never guess true. */
  isCorrect: boolean | null;
};

export type DraftBlank = {
  blankIndex: number;
  acceptableAnswers: string[];
};

export type DraftQuestion = {
  localId: string;
  sequence: number;
  type: QuestionBankQuestionType | null;
  prompt: string;
  score: number | null;
  options: DraftOption[];
  blanks: DraftBlank[];
  needsReview: boolean;
  reviewReasons: string[];
  sourceFragmentIds: string[];
  originalSnippet: string;
};

export type DraftQuestionInput = DraftQuestion & {
  /** Required to clear parser/OCR uncertainty; client-supplied needsReview is never trusted. */
  reviewConfirmed?: boolean;
};

export type ParsedImportPayload = {
  stage: ImportStage;
  bankName: string;
  description?: string | null;
  mode: ImportParseMode;
  questions: DraftQuestion[];
  sourceFragments: SourceFragment[];
  extraction?: {
    pages?: number;
    ocrUsed?: boolean;
    language?: string;
    format?: string;
  };
};

export type ParseResult = {
  bankName: string;
  description?: string | null;
  mode: ImportParseMode;
  source: QuestionBankSource;
  questions: DraftQuestion[];
  sourceFragments: SourceFragment[];
  warnings: ImportWarning[];
  extraction?: ParsedImportPayload["extraction"];
};

export type QuestionBankImportFileInput = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

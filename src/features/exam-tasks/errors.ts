export type ExamTaskErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "BANK_NOT_SELECTABLE"
  | "NO_ASSIGNEES"
  | "INELIGIBLE_ASSIGNEES"
  | "IDEMPOTENCY_CONFLICT"
  | "FORBIDDEN";

export class ExamTaskError extends Error {
  readonly code: ExamTaskErrorCode;

  constructor(message: string, code: ExamTaskErrorCode = "VALIDATION_ERROR") {
    super(message);
    this.name = "ExamTaskError";
    this.code = code;
  }
}

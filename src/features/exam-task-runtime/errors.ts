export type ExamTaskRuntimeErrorCode =
  | "ASSIGNMENT_NOT_FOUND"
  | "ATTEMPT_NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_STARTED"
  | "TASK_ENDED"
  | "NO_ATTEMPTS_LEFT"
  | "INVALID_ANSWER"
  | "ATTEMPT_CLOSED"
  | "INVALID_STATE";

export class ExamTaskRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: ExamTaskRuntimeErrorCode,
  ) {
    super(message);
    this.name = "ExamTaskRuntimeError";
  }
}

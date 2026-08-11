export class QuestionBankError extends Error {
  readonly code: string;

  constructor(message: string, code = "QUESTION_BANK_ERROR") {
    super(message);
    this.name = "QuestionBankError";
    this.code = code;
  }
}

export class QuestionBankQuestionError extends Error {
  readonly code: string;

  constructor(message: string, code = "QUESTION_BANK_QUESTION_ERROR") {
    super(message);
    this.name = "QuestionBankQuestionError";
    this.code = code;
  }
}

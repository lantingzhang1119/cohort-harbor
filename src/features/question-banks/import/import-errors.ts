export class QuestionBankImportError extends Error {
  readonly code: string;

  constructor(message: string, code = "QUESTION_BANK_IMPORT_ERROR") {
    super(message);
    this.name = "QuestionBankImportError";
    this.code = code;
  }
}

export class QuestionBankImportFileError extends Error {
  readonly code:
    | "INVALID_EXTENSION"
    | "INVALID_MIME"
    | "INVALID_SIGNATURE"
    | "INVALID_PACKAGE"
    | "MACRO_NOT_ALLOWED"
    | "ARCHIVE_LIMIT_EXCEEDED"
    | "FILE_TOO_LARGE"
    | "UNSUPPORTED_FORMAT"
    | "DANGEROUS_FILE_NAME";

  constructor(
    code: QuestionBankImportFileError["code"],
    message: string,
  ) {
    super(message);
    this.name = "QuestionBankImportFileError";
    this.code = code;
  }
}

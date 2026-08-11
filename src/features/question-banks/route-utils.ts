import { NextResponse } from "next/server";

import { QuestionBankError, QuestionBankQuestionError } from "@/features/question-banks/errors";

export function questionBankErrorResponse(error: unknown) {
  if (error instanceof QuestionBankError || error instanceof QuestionBankQuestionError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "DEFAULT_PROTECTED"
          ? 409
          : 400;
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status });
  }
  return null;
}

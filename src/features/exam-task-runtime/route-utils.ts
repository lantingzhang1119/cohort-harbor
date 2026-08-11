import { NextResponse } from "next/server";

import { ExamTaskRuntimeError } from "@/features/exam-task-runtime/errors";

export function examTaskRuntimeErrorResponse(error: unknown) {
  if (!(error instanceof ExamTaskRuntimeError)) return null;
  const status =
    error.code === "FORBIDDEN"
      ? 403
      : error.code.endsWith("NOT_FOUND")
        ? 404
        : error.code === "INVALID_ANSWER"
          ? 400
          : 409;
  return NextResponse.json(
    { ok: false, code: error.code, message: error.message },
    { status },
  );
}

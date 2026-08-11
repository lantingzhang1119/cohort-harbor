import { NextResponse } from "next/server";

import { AuthError } from "@/features/auth/errors";
import { ExamTaskError } from "@/features/exam-tasks/errors";

export function examTaskErrorResponse(error: unknown) {
  if (error instanceof ExamTaskError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "IDEMPOTENCY_CONFLICT"
          ? 409
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "NO_ASSIGNEES" ||
              error.code === "INELIGIBLE_ASSIGNEES" ||
              error.code === "BANK_NOT_SELECTABLE"
            ? 400
            : 400;
    return NextResponse.json(
      { ok: false, message: error.message, code: error.code },
      { status },
    );
  }
  if (error instanceof AuthError) {
    return null;
  }
  return null;
}

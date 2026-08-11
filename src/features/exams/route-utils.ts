import { NextResponse } from "next/server";

import { AttemptServiceError } from "@/features/exams/attempt-service";

export function attemptErrorResponse(error: unknown) {
  if (!(error instanceof AttemptServiceError)) return null;
  const status = error.code === "FORBIDDEN" ? 403 : error.code.endsWith("NOT_FOUND") ? 404 : 409;
  return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status });
}

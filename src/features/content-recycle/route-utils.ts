import { NextResponse } from "next/server";

import { ContentRecycleError } from "@/features/content-recycle/errors";
import { AuthError } from "@/features/auth/errors";
import { authErrorResponse } from "@/features/auth/route-utils";

export function contentRecycleErrorResponse(error: unknown) {
  if (error instanceof ContentRecycleError) {
    const status =
      error.code === "CONFIRMATION_REQUIRED" || error.code === "INVALID_STATE"
        ? 400
        : error.code === "NOT_FOUND" || error.code === "NOT_IN_RECYCLE_BIN" || error.code === "NOT_DELETED"
          ? 404
          : error.code === "ALREADY_DELETED"
            ? 409
            : 400;
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status });
  }
  if (error instanceof AuthError) return authErrorResponse(error);
  return null;
}

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AuthError } from "@/features/auth/errors";

const domainBadRequestCodes = new Set([
  "INVALID_ASSET_REFERENCE", "INVALID_MATERIAL_VERSION", "INVALID_CC_USER", "DUPLICATE_CONTENT_ID", "INVALID_BACKGROUND_REFERENCE", "RECIPIENT_EMAIL_MISSING",
  "INVALID_INLINE_TYPE", "INVALID_CONTENT_ID", "UNEXPECTED_CONTENT_ID", "ASSET_INTEGRITY_MISMATCH",
  "INVALID_EMAIL", "AMBIGUOUS_NAME", "NAME_NOT_FOUND", "ACCOUNT_NOT_AVAILABLE", "ACCOUNT_EMAIL_MISSING",
  "MALFORMED_PLACEHOLDER", "UNKNOWN_PLACEHOLDER", "MISSING_PLACEHOLDER_VALUE", "INVALID_IMAGE_SOURCE", "INVALID_SUBJECT",
  "UNKNOWN_FIELD", "INVALID_FIELD_CONFIG", "INVALID_DATE_FORMAT", "DUPLICATE_FIELD", "MISSING_REQUIRED_FIELD",
  "INVALID_HEADER", "MIME_BOUNDARY_COLLISION",
]);
const domainConflictCodes = new Set(["UNKNOWN_RESOLUTION_CONFLICT"]);
const domainTooLargeCodes = new Set(["ASSET_TOO_LARGE", "RAW_ATTACHMENTS_TOO_LARGE", "ENCODED_MIME_TOO_LARGE"]);

export function onboardingMailErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ ok: false, code: "VALIDATION_ERROR", message: "请求参数无效", issues: error.issues }, { status: 400 });
  }
  if (error && typeof error === "object" && "code" in error && "status" in error) {
    const item = error as { code: unknown; status: unknown; message?: unknown };
    if (typeof item.code === "string" && typeof item.status === "number") {
      return NextResponse.json({
        ok: false,
        code: item.code,
        message: typeof item.message === "string" ? item.message : "请求失败",
      }, { status: item.status });
    }
  }
  if (error && typeof error === "object" && "code" in error) {
    const item = error as { code?: unknown; message?: unknown };
    if (typeof item.code === "string") {
      const status = domainBadRequestCodes.has(item.code) ? 400
        : domainConflictCodes.has(item.code) ? 409
          : domainTooLargeCodes.has(item.code) ? 413
            : item.code === "UNKNOWN_RESOLUTION_RETRY_EXHAUSTED" ? 503
              : null;
      if (status) return NextResponse.json({
        ok: false,
        code: item.code,
        message: typeof item.message === "string" ? item.message : "请求失败",
      }, { status });
    }
  }
  return NextResponse.json({ ok: false, code: "REQUEST_FAILED", message: "邮件中心操作失败，请检查输入后重试" }, { status: 400 });
}

import { NextResponse } from "next/server";
import { z } from "zod";

import { PortalAssetReferenceError } from "@/features/portal/portal-asset-references";
import { PortalImageError } from "@/features/portal/portal-file-validation";
import { PortalRequestBodyError } from "@/features/portal/portal-request-body";
import { PortalServiceError } from "@/features/portal/portal-service";

export function portalErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ ok: false, message: "门户布局参数无效", issues: error.issues }, { status: 400 });
  }
  if (error instanceof PortalImageError) {
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof PortalRequestBodyError) {
    return NextResponse.json(
      { ok: false, message: error.message, code: error.code },
      { status: error.code === "BODY_TOO_LARGE" ? 413 : 400 },
    );
  }
  if (error instanceof PortalAssetReferenceError) {
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof PortalServiceError) {
    const status = error.code === "ASSET_CLEANUP_FAILED" ? 500
      : error.code === "ASSET_NOT_FOUND" || error.code === "PUBLICATION_NOT_FOUND" ? 404
      : error.code === "ASSET_REFERENCED" || error.code === "DRAFT_CONFLICT" ? 409 : 400;
    return NextResponse.json({ ok: false, message: error.message, code: error.code }, { status });
  }
  return null;
}

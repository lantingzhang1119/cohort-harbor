import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { OnboardingUploadError } from "@/features/onboarding-kit/file-validation";
import { OnboardingZipError } from "@/features/onboarding-kit/zip-service";
import { authErrorResponse } from "@/features/auth/route-utils";

export const MAX_ONBOARDING_FILE_BYTES = Number(process.env.ONBOARDING_MATERIAL_MAX_BYTES ?? 50 * 1024 * 1024);

export function onboardingNotFound() {
  return NextResponse.json({ ok: false, message: "资料不存在或当前不可用" }, { status: 404 });
}

export function onboardingErrorResponse(error: unknown) {
  if (error instanceof OnboardingUploadError) {
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: 400 });
  }
  if (error instanceof OnboardingZipError) {
    const status = error.code === "BUILD_BUSY" ? 429 : error.code === "INSUFFICIENT_DISK_SPACE" ? 507 : error.code === "SELECTION_CHANGED" ? 409 : 400;
    return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ ok: false, message: error.issues[0]?.message ?? "资料信息无效" }, { status: 400 });
  }
  if (error && typeof error === "object" && "code" in error && String(error.code) === "P2025") return onboardingNotFound();
  return authErrorResponse(error);
}

export function toUploadFile(file: File) {
  return { fileName: file.name, mimeType: file.type, size: file.size, stream: () => file.stream() };
}

export function materialFormInput(form: FormData) {
  return {
    title: String(form.get("title") ?? ""),
    category: String(form.get("category") ?? ""),
    description: String(form.get("description") ?? "") || null,
    sortOrder: Number(form.get("sortOrder") ?? 0),
  };
}

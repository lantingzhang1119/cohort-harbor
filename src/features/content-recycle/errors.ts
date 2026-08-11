import { AuthError } from "@/features/auth/errors";

export type ContentRecycleErrorCode =
  | "NOT_FOUND"
  | "NOT_IN_RECYCLE_BIN"
  | "ALREADY_DELETED"
  | "NOT_DELETED"
  | "CONFIRMATION_REQUIRED"
  | "INVALID_STATE";

const messages: Record<ContentRecycleErrorCode, string> = {
  NOT_FOUND: "目标不存在",
  NOT_IN_RECYCLE_BIN: "目标不在回收站中",
  ALREADY_DELETED: "目标已在回收站中",
  NOT_DELETED: "目标尚未进入回收站，不能永久删除",
  CONFIRMATION_REQUIRED: "永久删除需要再次确认",
  INVALID_STATE: "当前状态不允许此操作",
};

export class ContentRecycleError extends Error {
  constructor(
    public readonly code: ContentRecycleErrorCode,
    message = messages[code],
  ) {
    super(message);
    this.name = "ContentRecycleError";
  }
}

export function assertAdminActorRole(role: string) {
  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    throw new AuthError("FORBIDDEN", 403);
  }
}

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "AMBIGUOUS_IDENTIFIER"
  | "ACCOUNT_LOCKED"
  | "UNAUTHENTICATED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "FORBIDDEN"
  | "MODULE_DISABLED"
  | "REAL_NAME_REQUIRED"
  | "INVALID_ORIGIN";

const publicMessages: Record<AuthErrorCode, string> = {
  INVALID_CREDENTIALS: "姓名/工号或密码不正确",
  AMBIGUOUS_IDENTIFIER: "存在同名员工，请使用工号登录",
  ACCOUNT_LOCKED: "登录失败次数过多，请稍后再试",
  UNAUTHENTICATED: "请先登录",
  PASSWORD_CHANGE_REQUIRED: "请先修改初始密码",
  FORBIDDEN: "无权访问此功能",
  MODULE_DISABLED: "该板块当前未开放",
  REAL_NAME_REQUIRED: "请先将管理员账号姓名修改为真实姓名",
  INVALID_ORIGIN: "请求来源无效，请刷新页面后重试",
};

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly status: number,
  ) {
    super(publicMessages[code]);
    this.name = "AuthError";
  }
}

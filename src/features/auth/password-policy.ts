import { z } from "zod";

const NEW_PASSWORD_MESSAGE = "密码至少 8 位，且必须同时包含英文字母和数字";

export function isValidNewPassword(password: string): boolean {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export const newPasswordSchema = z
  .string()
  .refine(isValidNewPassword, NEW_PASSWORD_MESSAGE);

export function validateNewPassword(value: string) {
  return newPasswordSchema.safeParse(value);
}

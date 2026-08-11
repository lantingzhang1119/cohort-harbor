import { hashPasswordResetToken } from "@/features/auth/password-reset-service";

export const TEST_AUTH_TOKEN_SECRET = "test-only-auth-token-hmac-secret-2026";

export function hashTestPasswordResetToken(token: string) {
  return hashPasswordResetToken(token, TEST_AUTH_TOKEN_SECRET);
}

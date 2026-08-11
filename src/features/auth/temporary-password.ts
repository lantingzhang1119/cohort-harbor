import { randomInt } from "node:crypto";

import { isValidNewPassword } from "@/features/auth/password-policy";

const TEMPORARY_PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateTemporaryPassword(): string {
  do {
    let password = "";
    for (let index = 0; index < 10; index += 1) {
      password += TEMPORARY_PASSWORD_ALPHABET[
        randomInt(TEMPORARY_PASSWORD_ALPHABET.length)
      ];
    }
    if (isValidNewPassword(password)) return password;
  } while (true);
}

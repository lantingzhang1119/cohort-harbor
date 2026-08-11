import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(
  password: string,
  salt: Buffer,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedValue: string,
): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltHex, expectedHex, extra] =
    storedValue.split("$");
  if (
    algorithm !== "scrypt" ||
    extra !== undefined ||
    !saltHex ||
    !expectedHex ||
    !/^[a-f0-9]+$/i.test(saltHex) ||
    !/^[a-f0-9]+$/i.test(expectedHex)
  ) {
    return false;
  }

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || r < 1 || p < 1) {
    return false;
  }

  try {
    const expected = Buffer.from(expectedHex, "hex");
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await deriveKey(password, Buffer.from(saltHex, "hex"), {
      N,
      r,
      p,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

import { createHash, randomBytes } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { SessionViewMode } from "@/generated/prisma/enums";

type SessionClient = Pick<PrismaClient, "session"> | Prisma.TransactionClient;

export const SESSION_COOKIE_NAME = "cohort_harbor_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createSession(
  db: SessionClient,
  userId: string,
  options: { now?: Date; ttlHours?: number; viewMode?: SessionViewMode } = {},
) {
  const now = options.now ?? new Date();
  const ttlHours = options.ttlHours ?? 12;
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      viewMode: options.viewMode ?? SessionViewMode.EMPLOYEE,
      expiresAt,
    },
  });

  return { token, expiresAt, sessionId: session.id };
}

export async function revokeSession(db: SessionClient, token: string, now = new Date()) {
  await db.session.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: now },
  });
}

export async function getActiveSession(
  db: PrismaClient,
  token: string | undefined,
  now = new Date(),
) {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    !session.user.enabled ||
    session.user.status !== "ACTIVE"
  ) {
    return null;
  }
  return session;
}

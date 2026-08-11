import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export function withTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(callback);
}

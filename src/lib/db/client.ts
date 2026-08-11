import { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/db/create-client";

export { createPrismaClient };

declare global {
  var __cohortHarborPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__cohortHarborPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__cohortHarborPrisma = prisma;
}

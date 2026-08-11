import type { PrismaClient } from "@/generated/prisma/client";
import { purgeExpiredMaterialRecycleBin } from "@/features/onboarding-kit/material-recycle-service";
import { purgeExpiredPolicyRecycleBin } from "@/features/policies/policy-recycle-service";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";

export async function purgeExpiredContentRecycleBin(options: {
  db: PrismaClient;
  privateRoot?: string;
  now?: Date;
  retentionMs?: number;
}) {
  const privateRoot = options.privateRoot ?? defaultPrivateRoot;
  const [policies, materials] = await Promise.all([
    purgeExpiredPolicyRecycleBin(options.db, {
      privateRoot,
      now: options.now,
      retentionMs: options.retentionMs,
    }),
    purgeExpiredMaterialRecycleBin(
      { db: options.db, privateRoot, maxBytes: 0 },
      { now: options.now, retentionMs: options.retentionMs },
    ),
  ]);
  return { policies, materials };
}

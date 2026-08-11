import type { PrismaClient, User } from "@/generated/prisma/client";
import {
  EmployeeModuleKey,
  FileAssetKind,
  SessionViewMode,
} from "@/generated/prisma/enums";
import { AuthError } from "@/features/auth/errors";
import { requireEmployeeViewAccess } from "@/features/auth/guards";
import { getEnabledEmployeeModules } from "@/features/employee-modules/module-service";
import { prisma } from "@/lib/db/client";

type EmployeeViewContext = {
  user: User;
  viewMode: SessionViewMode;
};

const genericAssetModule = new Map<FileAssetKind, EmployeeModuleKey>([
  [FileAssetKind.GUIDE_IMAGE, EmployeeModuleKey.GUIDES],
  [FileAssetKind.GUIDE_MAP, EmployeeModuleKey.GUIDES],
  [FileAssetKind.PORTAL_IMAGE, EmployeeModuleKey.GUIDES],
]);

export async function requireEmployeeModule(
  context: EmployeeViewContext,
  key: EmployeeModuleKey,
  db: PrismaClient = prisma,
): Promise<User> {
  const user = requireEmployeeViewAccess(context);
  const enabled = await getEnabledEmployeeModules(db);
  if (!enabled.has(key)) throw new AuthError("MODULE_DISABLED", 403);
  return user;
}

export function employeeModuleForAsset(kind: FileAssetKind): EmployeeModuleKey | null {
  if (kind === FileAssetKind.ONBOARDING_MATERIAL) {
    return EmployeeModuleKey.ONBOARDING_KIT;
  }
  return genericAssetModule.get(kind) ?? null;
}

export function isKindServedByGenericFileRoute(kind: FileAssetKind): boolean {
  return genericAssetModule.has(kind);
}

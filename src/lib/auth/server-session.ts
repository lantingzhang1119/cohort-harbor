import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Role } from "@/generated/prisma/enums";
import {
  requireAdminAccess,
  requireEmployeeViewAccess,
  requireSessionForPasswordChange,
  requireSuperAdmin,
} from "@/features/auth/guards";
import { SESSION_COOKIE_NAME } from "@/features/auth/session";
import { requiresRealNameBeforeEmployeeView } from "@/features/auth/real-name";
import { prisma } from "@/lib/db/client";

export type PageCapability =
  | "ADMIN_ACCESS"
  | "SUPER_ADMIN_ACCESS"
  | "EMPLOYEE_VIEW_ACCESS";

export async function requirePageUser(capability: PageCapability) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  let session: Awaited<ReturnType<typeof requireSessionForPasswordChange>>;

  try {
    session = await requireSessionForPasswordChange(prisma, token);
  } catch {
    redirect("/login");
  }

  if (session.user.mustChangePassword) redirect("/change-password");
  if (
    capability === "EMPLOYEE_VIEW_ACCESS" &&
    requiresRealNameBeforeEmployeeView(session.user)
  ) {
    redirect("/profile/real-name");
  }
  try {
    if (capability === "SUPER_ADMIN_ACCESS") requireSuperAdmin(session);
    else if (capability === "ADMIN_ACCESS") requireAdminAccess(session);
    else requireEmployeeViewAccess(session);
  } catch {
    redirect(
      session.user.role !== Role.EMPLOYEE && session.viewMode === "ADMIN"
        ? "/admin"
        : "/employee",
    );
  }
  return session.user;
}

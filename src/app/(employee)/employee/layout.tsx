import type { ReactNode } from "react";

import { requirePageUser } from "@/lib/auth/server-session";
import { getEnabledEmployeeModules } from "@/features/employee-modules/module-service";
import { prisma } from "@/lib/db/client";
import { AppShell } from "@/lib/ui/app-shell";

export const dynamic = "force-dynamic";

export default async function EmployeeLayout({ children }: { children: ReactNode }) {
  const [user, enabledModules] = await Promise.all([
    requirePageUser("EMPLOYEE_VIEW_ACCESS"),
    getEnabledEmployeeModules(prisma),
  ]);
  return <AppShell variant="employee" user={user} enabledEmployeeModules={[...enabledModules]}>{children}</AppShell>;
}

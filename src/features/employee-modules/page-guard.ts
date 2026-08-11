import { redirect } from "next/navigation";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { employeePageDecision } from "@/features/employee-modules/module-definitions";
import { getEnabledEmployeeModules } from "@/features/employee-modules/module-service";
import { requirePageUser } from "@/lib/auth/server-session";
import { prisma } from "@/lib/db/client";

export async function requireEmployeeModulePage(key: EmployeeModuleKey) {
  const [user, enabled] = await Promise.all([
    requirePageUser("EMPLOYEE_VIEW_ACCESS"),
    getEnabledEmployeeModules(prisma),
  ]);
  const destination = employeePageDecision(enabled, key);
  if (destination) redirect(destination);
  return user;
}

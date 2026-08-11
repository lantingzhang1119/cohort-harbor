import { EmployeeModuleKey, Role } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";
import { findEnabledExamAssignment } from "@/features/exams/assignment-service";
import { TaskLanding } from "@/features/exam-task-runtime/components/task-landing";
import { prisma } from "@/lib/db/client";

export default async function ExamPage() {
  const user = await requireEmployeeModulePage(EmployeeModuleKey.EXAM);
  const isManagementAccount = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;
  const hasAssignment = isManagementAccount
    ? Boolean(await findEnabledExamAssignment(prisma, user.id))
    : true;
  return (
    <TaskLanding
      isManagementAccount={isManagementAccount}
      hasLegacyAssignment={hasAssignment}
    />
  );
}

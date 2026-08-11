import { redirect } from "next/navigation";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { getTaskAttemptForUser } from "@/features/exam-task-runtime/attempt-service";
import { TaskRunner } from "@/features/exam-task-runtime/components/task-runner";
import { ExamTaskRuntimeError } from "@/features/exam-task-runtime/errors";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";
import { prisma } from "@/lib/db/client";

export default async function TaskAttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireEmployeeModulePage(EmployeeModuleKey.EXAM);
  const { id } = await params;
  let closed = false;
  try {
    await getTaskAttemptForUser(prisma, id, user.id);
  } catch (error) {
    if (error instanceof ExamTaskRuntimeError && error.code === "ATTEMPT_CLOSED") {
      closed = true;
    } else {
      throw error;
    }
  }
  if (closed) redirect("/employee/results");
  return <TaskRunner attemptId={id} />;
}

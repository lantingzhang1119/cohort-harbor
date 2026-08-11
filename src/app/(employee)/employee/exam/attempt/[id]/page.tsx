import { ExamRunner } from "@/features/exams/components/exam-runner";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) { await requireEmployeeModulePage(EmployeeModuleKey.EXAM); const { id } = await params; return <ExamRunner attemptId={id} />; }

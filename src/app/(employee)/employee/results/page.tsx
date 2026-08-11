import { ResultsList } from "@/features/exams/components/results-list";
import { TaskResultsList } from "@/features/exam-task-runtime/components/task-results-list";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { requireEmployeeModulePage } from "@/features/employee-modules/page-guard";

export default async function ResultsPage() {
  await requireEmployeeModulePage(EmployeeModuleKey.RESULTS);
  return (
    <main className="employee-content">
      <header className="employee-hero">
        <p className="eyebrow">RESULTS · 成长记录</p>
        <h1>我的考试结果</h1>
        <p>每次考试记录独立保留，题库后续修改不会改变历史成绩。</p>
      </header>
      <TaskResultsList />
      <ResultsList />
    </main>
  );
}

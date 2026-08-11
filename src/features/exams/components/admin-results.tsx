"use client";

import { useEffect, useState } from "react";

import { AssignmentStatus } from "@/generated/prisma/enums";
import { useUrlFilters } from "@/lib/ui/use-url-filters";

type Assignment = {
  id: string;
  status: string;
  user: {
    employeeNo: string;
    name: string;
    firstDepartment: string | null;
    workLocation: string;
  };
  exam: { name: string };
  attempts: Array<{ attemptNo: number; score: number | null; passed: boolean | null }>;
};

type TaskAssignment = {
  id: string;
  status: string;
  user: Assignment["user"];
  task: {
    name: string;
    passingScore: number;
    snapshot: { questionBankName: string; questionBankVersion: number };
  };
  attempts: Array<{ attemptNo: number; score: number | null; passed: boolean | null }>;
};

type ResultsFilters = { status: string; employee: string; task: string; bank: string };

const resultFilterKeys = ["status", "employee", "task", "bank"] as const;
const assignmentStatuses = new Set<string>(Object.values(AssignmentStatus));
const statusLabels: Record<string, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  FAILED: "未通过",
  RETAKE_READY: "可直接补考",
  APPLICATION_REQUIRED: "需申请补考",
  PENDING_APPROVAL: "待审批",
  PASSED: "已通过",
  OVERDUE: "已逾期",
};

function readResultsFilters(params: URLSearchParams): ResultsFilters {
  const status = params.get("status") ?? "";
  return {
    status: assignmentStatuses.has(status) ? status : "",
    employee: params.get("employee") ?? "",
    task: params.get("task") ?? "",
    bank: params.get("bank") ?? "",
  };
}

export function AdminResults({
  initialStatus = "",
}: {
  initialStatus?: string;
} = {}) {
  const [items, setItems] = useState<Assignment[]>([]);
  const [taskItems, setTaskItems] = useState<TaskAssignment[]>([]);
  const [message, setMessage] = useState("正在加载考试成绩…");
  const [filters, updateFilters] = useUrlFilters(
    readResultsFilters(new URLSearchParams(initialStatus ? { status: initialStatus } : {})),
    resultFilterKeys,
    readResultsFilters,
  );
  const { status, employee, task, bank } = filters;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ status, employee, task, bank })) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    fetch(`/api/admin/results${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok?: boolean; assignments?: Assignment[]; taskAssignments?: TaskAssignment[]; message?: string }) => {
        setItems(result.assignments ?? []);
        setTaskItems(result.taskAssignments ?? []);
        setMessage((result.assignments?.length || result.taskAssignments?.length) ? "" : result.message ?? "暂无符合条件的考试任务");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("考试成绩加载失败");
        }
      });
    return () => controller.abort();
  }, [status, employee, task, bank]);

  return (
    <main className="admin-content">
      <header className="page-title-row"><div><p className="eyebrow">RESULTS · 学习进度</p><h1>考试成绩</h1><p>查看员工任务状态、最新得分与考试次数。</p></div></header>
      <section className="filter-panel compact-filter-panel" aria-label="成绩筛选">
        <label><span>任务状态</span><select value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}><option value="">全部状态</option>{Object.values(AssignmentStatus).map((status) => <option key={status} value={status}>{statusLabels[status] ?? status}</option>)}</select></label>
        <label><span>员工</span><input value={filters.employee} onChange={(event) => updateFilters({ employee: event.target.value })} placeholder="姓名或工号" /></label>
        <label><span>考试任务</span><input value={filters.task} onChange={(event) => updateFilters({ task: event.target.value })} placeholder="任务名称" /></label>
        <label><span>题库</span><input value={filters.bank} onChange={(event) => updateFilters({ bank: event.target.value })} placeholder="题库名称" /></label>
      </section>
      <p className="status-message" aria-live="polite">{message}</p>
      <section className="admin-results-table">
        {taskItems.map((item) => <article key={`task-${item.id}`}><div><strong>{item.user.name}</strong><span>{item.user.employeeNo} · {item.user.firstDepartment ?? "未设置部门"}</span></div><div><strong>{item.task.name}</strong><span>{item.task.snapshot.questionBankName} v{item.task.snapshot.questionBankVersion}</span></div><span className="tag">{statusLabels[item.status] ?? item.status}</span><div><strong>{item.attempts[0]?.score ?? "-"}</strong><span>第 {item.attempts[0]?.attemptNo ?? 0} 次</span></div></article>)}
      </section>
      <section className="admin-results-table">{items.map((item) => <article key={item.id}><div><strong>{item.user.name}</strong><span>{item.user.employeeNo} · {item.user.firstDepartment ?? "未设置部门"}</span></div><span className="tag">{statusLabels[item.status] ?? item.status}</span><div><strong>{item.attempts[0]?.score ?? "-"}</strong><span>第 {item.attempts[0]?.attemptNo ?? 0} 次</span></div></article>)}</section>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

import { RetakeStatus } from "@/generated/prisma/enums";
import { useUrlFilters } from "@/lib/ui/use-url-filters";

type Application = {
  id: string;
  status: string;
  reason: string;
  requester: { name: string; employeeNo: string; firstDepartment: string | null };
  assignment: { exam: { name: string }; attempts: Array<{ score: number | null; attemptNo: number }> };
};

type RetakeFilters = { status: string };

const retakeFilterKeys = ["status"] as const;
const retakeStatuses = new Set<string>(Object.values(RetakeStatus));
const retakeStatusLabels: Record<string, string> = {
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
};

function readRetakeFilters(params: URLSearchParams): RetakeFilters {
  const status = params.get("status") ?? RetakeStatus.PENDING;
  return { status: retakeStatuses.has(status) ? status : RetakeStatus.PENDING };
}

export function RetakeAdmin({
  initialStatus = RetakeStatus.PENDING,
}: {
  initialStatus?: string;
} = {}) {
  const [items, setItems] = useState<Application[]>([]);
  const [message, setMessage] = useState("");
  const [filters, updateFilters] = useUrlFilters(
    readRetakeFilters(new URLSearchParams({ status: initialStatus })),
    retakeFilterKeys,
    readRetakeFilters,
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetch(`/api/admin/retakes?status=${filters.status}`, { signal })
      .then((response) => response.json()) as { applications?: Application[] };
    setItems(result.applications ?? []);
  }, [filters.status]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/retakes?status=${filters.status}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { applications?: Application[] }) => setItems(result.applications ?? []))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("补考申请加载失败");
        }
      });
    return () => controller.abort();
  }, [filters.status]);

  async function review(id: string, approve: boolean) {
    const response = await fetch(`/api/admin/retakes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve, note: approve ? "同意补考" : "请先完成制度复习" }),
    });
    setMessage(response.ok ? "审批已完成并通知员工" : "审批失败");
    await load();
  }

  return (
    <main className="admin-content">
      <header className="page-title-row"><div><p className="eyebrow">RETAKES · 审批</p><h1>补考申请</h1><p>审批通过只增加一次机会，并自动生成站内通知。</p></div></header>
      <section className="filter-panel compact-filter-panel" aria-label="补考筛选"><label><span>审批状态</span><select value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}>{Object.values(RetakeStatus).map((status) => <option key={status} value={status}>{retakeStatusLabels[status]}</option>)}</select></label></section>
      <p className="status-message" aria-live="polite">{message}</p>
      <section className="retake-admin-list">{items.map((item) => <article key={item.id}><div><strong>{item.requester.name}</strong><span>{item.requester.employeeNo} · {item.requester.firstDepartment ?? "未设置部门"}</span><p>{item.reason}</p></div><span>{retakeStatusLabels[item.status] ?? item.status} · 最近得分 {item.assignment.attempts[0]?.score ?? "-"}</span>{item.status === RetakeStatus.PENDING && <div><button type="button" onClick={() => void review(item.id, false)}>拒绝</button><button type="button" onClick={() => void review(item.id, true)}>通过</button></div>}</article>)}</section>
    </main>
  );
}

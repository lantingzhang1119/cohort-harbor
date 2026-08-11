"use client";

import { useEffect, useState } from "react";

import { ImportBatchStatus } from "@/generated/prisma/enums";
import { useUrlFilters } from "@/lib/ui/use-url-filters";

type Batch = {
  id: string;
  originalFileName: string;
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  disabledCount: number;
  conflictCount: number;
  createdAt: string;
};

type RosterFilters = { status: string };

const rosterFilterKeys = ["status"] as const;
const rosterStatuses = new Set<string>(Object.values(ImportBatchStatus));
const rosterStatusLabels: Record<string, string> = {
  PREVIEW: "预检中",
  READY: "待提交",
  COMMITTED: "已提交",
  FAILED: "失败",
};

function readRosterFilters(params: URLSearchParams): RosterFilters {
  const status = params.get("status") ?? "";
  return { status: rosterStatuses.has(status) ? status : "" };
}

export function RosterHistory({
  initialStatus = "",
}: {
  initialStatus?: string;
} = {}) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [message, setMessage] = useState("正在加载…");
  const [filters, updateFilters] = useUrlFilters(
    readRosterFilters(new URLSearchParams(initialStatus ? { status: initialStatus } : {})),
    rosterFilterKeys,
    readRosterFilters,
  );

  useEffect(() => {
    const controller = new AbortController();
    const query = filters.status ? `?status=${filters.status}` : "";
    fetch(`/api/admin/roster/preview${query}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok: boolean; batches?: Batch[]; message?: string }) => {
        setBatches(result.batches ?? []);
        setMessage(result.ok && result.batches?.length ? "" : result.message ?? "暂无导入记录");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("历史记录加载失败");
        }
      });
    return () => controller.abort();
  }, [filters.status]);

  return (
    <main className="admin-content">
      <header className="page-title-row"><div><p className="eyebrow">ROSTER · 审计轨迹</p><h1>导入历史</h1><p>仅显示文件名、批次状态与汇总计数。</p></div></header>
      <section className="filter-panel compact-filter-panel" aria-label="导入历史筛选"><label><span>批次状态</span><select value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}><option value="">全部状态</option>{Object.values(ImportBatchStatus).map((status) => <option key={status} value={status}>{rosterStatusLabels[status]}</option>)}</select></label></section>
      <p className="status-message" aria-live="polite">{message}</p>
      <section className="history-list">{batches.map((batch) => <article key={batch.id}><div><strong>{batch.originalFileName}</strong><span>{new Date(batch.createdAt).toLocaleString("zh-CN")} · {rosterStatusLabels[batch.status] ?? batch.status}</span></div><dl><div><dt>总行数</dt><dd>{batch.totalRows}</dd></div><div><dt>新增</dt><dd>{batch.createdCount}</dd></div><div><dt>更新</dt><dd>{batch.updatedCount}</dd></div><div><dt>停用</dt><dd>{batch.disabledCount}</dd></div><div><dt>冲突</dt><dd>{batch.conflictCount}</dd></div></dl></article>)}</section>
    </main>
  );
}

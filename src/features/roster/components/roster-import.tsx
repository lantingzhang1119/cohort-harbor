"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

type Conflict = { id: string; type: string; rowNumber: number };
type Preview = {
  batchId: string;
  summary: Record<string, number>;
  conflicts: Conflict[];
  issues: Array<{ rowNumber: number; message: string }>;
};

const conflictLabels: Record<string, string> = {
  DUPLICATE_EMPLOYEE_NO: "重复工号",
  DUPLICATE_EMAIL: "重复邮箱",
  INVALID_ROW: "无效数据行",
  REHIRE_CONFIRMATION: "返聘确认",
};

export function RosterImport() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("正在读取并预检名册…");
    const response = await fetch("/api/admin/roster/preview", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    const result = (await response.json()) as Preview & { ok: boolean; message?: string };
    if (result.ok) {
      setPreview(result);
      setMessage("预检完成。请确认摘要并处理全部冲突。");
    } else setMessage(result.message ?? "预检失败");
    setBusy(false);
  }

  async function commit() {
    if (!preview) return;
    if (preview.conflicts.some((conflict) => !decisions[conflict.id])) {
      setMessage("请先处理全部冲突");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/admin/roster/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchId: preview.batchId,
        decisions: preview.conflicts.map((conflict) => ({
          conflictId: conflict.id,
          resolution: decisions[conflict.id],
        })),
      }),
    });
    const result = (await response.json()) as { ok: boolean; message?: string; createdCount?: number; updatedCount?: number };
    setMessage(result.ok ? `导入完成：新增 ${result.createdCount ?? 0}，更新 ${result.updatedCount ?? 0}` : result.message ?? "导入失败");
    setBusy(false);
  }

  return (
    <main className="admin-content compact-content roster-import-page">
      <header className="page-title-row"><div><p className="eyebrow">ROSTER · 本地 Excel</p><h1>导入员工名册</h1><p>先预检，再处理冲突，最后一次性提交。</p></div><Link href="/admin/roster/history">导入历史</Link></header>
      <form className="upload-card" onSubmit={upload}>
        <label htmlFor="roster-file"><strong>选择员工名册</strong><span>支持 .xls / .xlsx，最大 20 MB；原始文件不会保存。</span></label>
        <input id="roster-file" name="file" type="file" accept=".xls,.xlsx" required />
        <button className="primary-action" type="submit" disabled={busy}>开始预检</button>
      </form>
      <p className="status-message" role="status">{message}</p>
      {preview && (
        <>
          <section className="summary-grid">
            {Object.entries(preview.summary).map(([label, value]) => <article key={label}><strong>{value}</strong><span>{label}</span></article>)}
          </section>
          {preview.issues.length > 0 && <section className="issue-list"><h2>数据问题</h2>{preview.issues.map((issue, index) => <p key={`${issue.rowNumber}-${index}`}>第 {issue.rowNumber} 行：{issue.message}</p>)}</section>}
          {preview.conflicts.length > 0 && <section className="issue-list"><h2>冲突处理</h2>{preview.conflicts.map((conflict) => <label key={conflict.id}><span>第 {conflict.rowNumber} 行 · {conflictLabels[conflict.type] ?? conflict.type}</span><select value={decisions[conflict.id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [conflict.id]: event.target.value }))}><option value="">请选择</option>{conflict.type === "REHIRE_CONFIRMATION" ? <><option value="KEEP_PASSWORD">返聘并保留密码</option><option value="RESET_PASSWORD">返聘并重置密码</option></> : conflict.type === "INVALID_ROW" ? <><option value="SKIP">跳过此行</option><option value="MANUAL_REIMPORT">修正后重新导入</option></> : <><option value="KEEP_FIRST">保留第一行</option><option value="KEEP_LAST">保留最后一行</option><option value="SKIP">全部跳过</option><option value="MANUAL_REIMPORT">修正后重新导入</option></>}</select></label>)}</section>}
          <button className="primary-action commit-button" type="button" disabled={busy} onClick={() => void commit()}>确认并提交导入</button>
        </>
      )}
    </main>
  );
}

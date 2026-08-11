"use client";

import { useEffect, useState } from "react";

type Assignment = { id: string; status: string; exam: { name: string }; retakeApplications: Array<{ status: string; reason: string; reviewNote: string | null }> };

export function RetakePanel() {
  const [items, setItems] = useState<Assignment[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  async function load() { const result = await fetch("/api/retakes").then((response) => response.json()) as { assignments?: Assignment[] }; setItems(result.assignments ?? []); }
  useEffect(() => { void fetch("/api/retakes").then((response) => response.json()).then((result: { assignments?: Assignment[] }) => setItems(result.assignments ?? [])); }, []);
  async function apply(id: string) { const response = await fetch("/api/retakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignmentId: id, reason: reasons[id] ?? "" }) }); const result = await response.json() as { ok: boolean; message?: string }; setMessage(result.ok ? "补考申请已提交" : result.message ?? "提交失败"); await load(); }
  return <><p className="status-message">{message}</p><section className="retake-list">{items.map((item) => <article key={item.id}><div><strong>{item.exam.name}</strong><span>{item.status}</span></div>{item.status === "APPLICATION_REQUIRED" && <><textarea placeholder="请说明复习情况与补考原因（至少 10 个字符）" value={reasons[item.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} /><button type="button" onClick={() => void apply(item.id)}>提交补考申请</button></>}{item.retakeApplications[0] && <p>最近申请：{item.retakeApplications[0].status}{item.retakeApplications[0].reviewNote ? ` · ${item.retakeApplications[0].reviewNote}` : ""}</p>}</article>)}</section></>;
}

"use client";

import { useEffect, useMemo, useState } from "react";

type Target = {
  assignmentId: string;
  userId: string;
  employeeNo: string;
  name: string;
  department: string | null;
  location: string;
  status: string;
  dueAt: string;
  email: string | null;
};
type Filters = { department: string; location: string; status: string };

const locations = [["SHANGHAI", "上海"], ["SHENZHEN", "深圳"], ["CHANGSHA", "长沙"], ["XIAN", "西安"], ["UNSET", "未设置"]];
const statuses = [["NOT_STARTED", "未开始"], ["IN_PROGRESS", "进行中"], ["RETAKE_READY", "待补考"], ["APPLICATION_REQUIRED", "待申请补考"], ["PASSED", "已通过"]];

function filterParams(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.department.trim()) params.set("department", filters.department.trim());
  if (filters.location) params.set("location", filters.location);
  if (filters.status) params.set("status", filters.status);
  return params;
}

function dueLabel(value: string) {
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天截止";
  return `距截止 ${days} 天`;
}

export function ReminderAdmin() {
  const [items, setItems] = useState<Target[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({ department: "", location: "", status: "" });
  const [message, setMessage] = useState("正在加载催办名单…");
  const query = useMemo(() => filterParams(filters).toString(), [filters]);

  async function load(activeFilters = filters) {
    const params = filterParams(activeFilters);
    const response = await fetch(`/api/admin/reminders${params.size ? `?${params}` : ""}`);
    const result = await response.json() as { targets?: Target[]; message?: string };
    setItems(result.targets ?? []);
    setSelected([]);
    setMessage(response.ok ? "" : result.message ?? "催办名单加载失败");
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/reminders", { signal: controller.signal })
      .then((response) => response.json().then((result: { targets?: Target[]; message?: string }) => ({ response, result })))
      .then(({ response, result }) => {
        setItems(result.targets ?? []);
        setSelected([]);
        setMessage(response.ok ? "" : result.message ?? "催办名单加载失败");
      });
    return () => controller.abort();
  }, []);

  async function send() {
    if (!selected.length) return;
    const response = await fetch("/api/admin/reminders/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientIds: selected, channels: ["IN_APP", "SIMULATED_EMAIL"] }),
    });
    setMessage(response.ok ? `已为 ${selected.length} 人生成站内通知与模拟邮件日志` : "催办失败");
  }

  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.userId));
  return <main className="admin-content">
    <header className="page-title-row"><div><p className="eyebrow">REMINDERS · 待办催办</p><h1>学习催办</h1><p>按部门、工作地点和任务状态筛选；本地 Demo 的邮件通道只记日志，不连接 SMTP。</p></div><a className="primary-action" href={`/api/admin/reminders/export${query ? `?${query}` : ""}`}>导出当前筛选 CSV</a></header>
    <section className="reminder-filters" aria-label="催办筛选">
      <label>部门<input value={filters.department} onChange={(event) => setFilters({ ...filters, department: event.target.value })} placeholder="输入完整部门名称" /></label>
      <label>工作地点<select value={filters.location} onChange={(event) => setFilters({ ...filters, location: event.target.value })}><option value="">全部地点</option>{locations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>任务状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="primary-action" type="button" onClick={() => void load()}>应用筛选</button>
      <button type="button" onClick={() => { const empty = { department: "", location: "", status: "" }; setFilters(empty); void load(empty); }}>清空</button>
    </section>
    <p className="status-message" role="status">{message || `当前 ${items.length} 条任务`}</p>
    {items.length > 0 && <div className="bulk-bar"><label><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map((item) => item.userId))} />全选当前结果</label><strong>已选 {selected.length} 人</strong><button type="button" disabled={!selected.length} onClick={() => void send()}>生成催办</button></div>}
    <section className="reminder-list">
      {items.map((item) => <label key={item.assignmentId}>
        <input type="checkbox" checked={selected.includes(item.userId)} onChange={() => setSelected((current) => current.includes(item.userId) ? current.filter((id) => id !== item.userId) : [...current, item.userId])} />
        <div><strong>{item.name}</strong><span>{item.employeeNo} · {item.department ?? "未设置部门"} · {locations.find(([value]) => value === item.location)?.[1] ?? item.location}</span></div>
        <span className="tag">{statuses.find(([value]) => value === item.status)?.[1] ?? item.status}</span>
        <time dateTime={item.dueAt}>{new Date(item.dueAt).toLocaleDateString("zh-CN")} · {dueLabel(item.dueAt)}</time>
      </label>)}
    </section>
  </main>;
}

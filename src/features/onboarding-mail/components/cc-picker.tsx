"use client";

import { useState } from "react";

type Candidate = { userId: string; employeeNo: string; name: string; email: string | null; label: string };
export type SelectedCc =
  | { kind: "USER"; userId: string; displayName: string; label: string; sortOrder: number }
  | { kind: "EMAIL"; email: string; displayName?: string; label: string; sortOrder: number };

export function CcPicker({ value, onChange }: { value: SelectedCc[]; onChange: (value: SelectedCc[]) => void }) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [message, setMessage] = useState("");

  async function search() {
    const response = await fetch(`/api/admin/onboarding-mail/cc-search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.message ?? "搜索失败"); return; }
    setCandidates(payload.candidates ?? []);
    setMessage(payload.candidates?.length ? "" : "没有匹配账号");
  }

  function select(candidate: Candidate) {
    if (value.some((item) => item.kind === "USER" && item.userId === candidate.userId)) return;
    onChange([...value, { kind: "USER", userId: candidate.userId, displayName: candidate.name, label: candidate.label, sortOrder: value.length + 1 }]);
    setCandidates([]);
    setQuery("");
  }

  function addExternalEmail() {
    const email = query.normalize("NFKC").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMessage("邮箱地址格式无效");
      return;
    }
    if (value.some((item) => item.kind === "EMAIL" && item.email === email)) {
      setMessage("该外部邮箱已添加");
      return;
    }
    onChange([...value, { kind: "EMAIL", email, label: email, sortOrder: value.length + 1 }]);
    setCandidates([]);
    setQuery("");
    setMessage("");
  }

  function selectedKey(item: SelectedCc) {
    return item.kind === "USER" ? `user:${item.userId}` : `email:${item.email}`;
  }

  return (
    <section className="mail-cc-picker" aria-label="抄送设置">
      <label>抄送姓名或邮箱<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" onClick={search}>搜索抄送</button>
      <button type="button" onClick={addExternalEmail}>添加外部邮箱</button>
      {message ? <p role="status">{message}</p> : null}
      {candidates.length ? <div className="mail-candidate-list">{candidates.map((candidate) => (
        <button type="button" key={candidate.userId} aria-label={`选择 ${candidate.label}`} onClick={() => select(candidate)}>{candidate.label}</button>
      ))}</div> : null}
      <div className="mail-chip-list">{value.map((item) => (
        <span className="mail-chip" key={selectedKey(item)}>{item.label}<button type="button" aria-label={`移除抄送 ${item.label}`} onClick={() => onChange(value.filter((entry) => selectedKey(entry) !== selectedKey(item)))}>×</button></span>
      ))}</div>
    </section>
  );
}

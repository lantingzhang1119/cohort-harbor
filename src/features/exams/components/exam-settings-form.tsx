"use client";

import { useEffect, useState, type FormEvent } from "react";

type Settings = { examId: string; durationMinutes: number; dueDaysAfterHire: number; watermarkOpacity: number; showWrongAnswers: boolean };

export function ExamSettingsForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("正在加载…");
  useEffect(() => { void fetch("/api/admin/exam-settings").then((response) => response.json()).then((result: { exam?: { id: string; durationMinutes: number; dueDaysAfterHire: number; showWrongAnswers: boolean }; setting?: { watermarkOpacity: number } }) => { if (result.exam) setSettings({ examId: result.exam.id, durationMinutes: result.exam.durationMinutes, dueDaysAfterHire: result.exam.dueDaysAfterHire, watermarkOpacity: result.setting?.watermarkOpacity ?? .07, showWrongAnswers: result.exam.showWrongAnswers }); setMessage(""); }); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!settings) return; const response = await fetch("/api/admin/exam-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) }); const result = await response.json() as { ok: boolean; message?: string }; setMessage(result.ok ? "考试设置已保存" : result.message ?? "保存失败"); }
  if (!settings) return <p className="status-message">{message}</p>;
  return <form className="exam-settings-card" onSubmit={submit}><label>考试时长（1–40 分钟）<input type="number" min="1" max="40" value={settings.durationMinutes} onChange={(event) => setSettings({ ...settings, durationMinutes: Number(event.target.value) })} /></label><label>入职后完成期限（1–65 天）<input type="number" min="1" max="65" value={settings.dueDaysAfterHire} onChange={(event) => setSettings({ ...settings, dueDaysAfterHire: Number(event.target.value) })} /></label><label>水印透明度（0.03–0.18）<input type="number" min="0.03" max="0.18" step="0.01" value={settings.watermarkOpacity} onChange={(event) => setSettings({ ...settings, watermarkOpacity: Number(event.target.value) })} /></label><label className="checkbox-label"><input type="checkbox" checked={settings.showWrongAnswers} onChange={(event) => setSettings({ ...settings, showWrongAnswers: event.target.checked })} />考试后显示错题</label><p className="form-message">{message}</p><button className="primary-action" type="submit">保存设置</button></form>;
}

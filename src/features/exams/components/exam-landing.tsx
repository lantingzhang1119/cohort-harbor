"use client";

import { useState } from "react";

export function ExamLanding({
  isManagementAccount = false,
  hasAssignment = true,
}: {
  isManagementAccount?: boolean;
  hasAssignment?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setMessage("正在生成本次试卷…");
    const response = await fetch("/api/exam/start", { method: "POST" });
    const result = await response.json() as { ok: boolean; attemptId?: string; message?: string };
    if (result.ok && result.attemptId) window.location.assign(`/employee/exam/attempt/${result.attemptId}`);
    else { setMessage(result.message ?? "暂时无法开始考试"); setBusy(false); }
  }
  if (isManagementAccount && !hasAssignment) {
    return <main className="employee-content"><section className="exam-landing-card"><span className="exam-chip">入职学习考试</span><h1>当前管理账号暂无学习任务</h1><p>如需体验员工学习流程，请先为当前账号分配学习任务。</p></section></main>;
  }
  return <main className="employee-content"><section className="exam-landing-card"><span className="exam-chip">入职学习考试</span><p className="eyebrow">READY · 100 分</p><h1>准备好检验你的制度学习成果了吗？</h1><p>共 23 题，满分 100 分，80 分及格。开始后由服务器计时，答案会自动保存。</p><div className="exam-facts"><span><strong>23</strong>题目</span><span><strong>80</strong>及格分</span><span><strong>自动</strong>保存</span></div><p className="status-message">{message}</p><button className="primary-action" type="button" disabled={busy} onClick={() => void start()}>{busy ? "正在进入…" : "开始 / 继续考试"}</button></section></main>;
}

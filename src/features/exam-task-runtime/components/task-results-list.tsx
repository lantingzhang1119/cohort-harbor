"use client";

import { useEffect, useState } from "react";

type TaskResult = {
  id: string;
  status: string;
  task: {
    name: string;
    passingScore: number;
    questionBankName: string;
    questionBankVersion: number;
  };
  attempts: Array<{
    id: string;
    attemptNo: number;
    score: number | null;
    passed: boolean | null;
    submittedAt: string | null;
    submissionReason: string | null;
  }>;
};

export function TaskResultsList() {
  const [items, setItems] = useState<TaskResult[]>([]);
  const [message, setMessage] = useState("正在加载批量考试结果…");
  useEffect(() => {
    void fetch("/api/exam/task-results")
      .then((response) => response.json())
      .then((result: { ok?: boolean; assignments?: TaskResult[]; message?: string }) => {
        setItems(result.assignments ?? []);
        setMessage(result.ok ? "" : result.message ?? "批量考试结果加载失败");
      })
      .catch(() => setMessage("批量考试结果加载失败"));
  }, []);
  const attempts = items.flatMap((assignment) =>
    assignment.attempts.map((attempt) => ({ assignment, attempt })),
  );
  return (
    <>
      <p className="status-message" role="status">{message}</p>
      <section className="results-list task-results-list">
        {attempts.map(({ assignment, attempt }) => (
          <article key={attempt.id}>
            <span className={attempt.passed ? "result-score passed" : "result-score failed"}>
              {attempt.score ?? "-"}
            </span>
            <div className="result-main">
              <p>{assignment.task.name} · 第 {attempt.attemptNo} 次</p>
              <h2>{attempt.passed ? "已通过" : attempt.submittedAt ? "未通过" : "进行中"}</h2>
              <small>
                {assignment.task.questionBankName} v{assignment.task.questionBankVersion}
                {" · "}及格线 {assignment.task.passingScore}
                {attempt.submissionReason === "TIMEOUT" ? " · 到期自动提交" : ""}
              </small>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

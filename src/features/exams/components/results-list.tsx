"use client";

import { useEffect, useState } from "react";

type WrongAnswer = {
  questionId: string;
  displayOrder: number;
  prompt: string;
  score: number;
  options: Array<{ key: string; text: string }>;
  selectedKeys: string[];
  correctKeys: string[];
};
type Assignment = {
  id: string;
  status: string;
  exam: { name: string; passingScore: number };
  attempts: Array<{
    id: string;
    attemptNo: number;
    score: number | null;
    passed: boolean | null;
    submittedAt: string | null;
    wrongAnswers?: WrongAnswer[];
  }>;
};

export function ResultsList() {
  const [items, setItems] = useState<Assignment[]>([]);
  const [message, setMessage] = useState("正在加载考试结果…");
  useEffect(() => {
    void fetch("/api/exam/results")
      .then((response) => response.json())
      .then((result: { ok?: boolean; assignments?: Assignment[]; message?: string }) => {
        setItems(result.assignments ?? []);
        setMessage(result.ok ? "" : result.message ?? "结果加载失败");
      });
  }, []);

  const attempts = items.flatMap((assignment) => assignment.attempts.map((attempt) => ({ assignment, attempt })));
  return <>
    <p className="status-message" role="status">{message || (attempts.length ? "" : "暂无历史考试记录")}</p>
    <section className="results-list">
      {attempts.map(({ assignment, attempt }) => <article key={attempt.id}>
        <span className={attempt.passed ? "result-score passed" : "result-score failed"}>{attempt.score ?? "-"}</span>
        <div className="result-main">
          <p>{assignment.exam.name} · 第 {attempt.attemptNo} 次</p>
          <h2>{attempt.passed ? "已通过" : attempt.submittedAt ? "未通过" : "进行中"}</h2>
          <small>{attempt.submittedAt ? new Date(attempt.submittedAt).toLocaleString("zh-CN") : "尚未提交"} · 及格线 {assignment.exam.passingScore}</small>
          {attempt.wrongAnswers !== undefined && <details className="wrong-answer-review">
            <summary>{attempt.wrongAnswers.length ? `查看 ${attempt.wrongAnswers.length} 道错题` : "本次没有错题"}</summary>
            {attempt.wrongAnswers.map((wrong) => <section key={wrong.questionId}>
              <strong>{String(wrong.displayOrder).padStart(2, "0")} · {wrong.prompt}</strong>
              <ul>{wrong.options.map((option) => <li className={wrong.correctKeys.includes(option.key) ? "correct" : wrong.selectedKeys.includes(option.key) ? "selected-wrong" : ""} key={option.key}><b>{option.key}</b>{option.text}{wrong.correctKeys.includes(option.key) && <span>正确答案</span>}{wrong.selectedKeys.includes(option.key) && !wrong.correctKeys.includes(option.key) && <span>你的答案</span>}</li>)}</ul>
            </section>)}
          </details>}
        </div>
      </article>)}
    </section>
  </>;
}

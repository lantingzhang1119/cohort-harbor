"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Watermark } from "@/lib/ui/watermark";

type Question = { questionId: string; displayOrder: number; prompt: string; type: string; score: number; options: Array<{ key: string; text: string }> };
type Attempt = { attemptId: string; expiresAt: string; questions: Question[]; answers: Record<string, string[]>; watermarkName: string; watermarkOpacity: number };

export function ExamRunner({ attemptId }: { attemptId: string }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [remaining, setRemaining] = useState(0);
  const [saveMessage, setSaveMessage] = useState("正在加载试卷…");
  const [submitting, setSubmitting] = useState(false);
  const autoSubmittedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/exam/attempt/${attemptId}/answer`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result: Attempt & { ok: boolean; message?: string }) => {
        if (result.ok) {
          setAttempt(result);
          setAnswers(result.answers ?? {});
          setRemaining(Math.max(0, Math.ceil((new Date(result.expiresAt).getTime() - Date.now()) / 1000)));
          setSaveMessage("");
        } else setSaveMessage(result.message ?? "试卷加载失败");
      })
      .catch(() => setSaveMessage("试卷加载失败"));
    return () => controller.abort();
  }, [attemptId]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!submitting) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [submitting]);

  const displayTime = useMemo(
    () => `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`,
    [remaining],
  );

  async function select(question: Question, key: string) {
    const current = answers[question.questionId] ?? [];
    const selectedKeys = question.type === "MULTIPLE"
      ? (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
      : [key];
    setAnswers((value) => ({ ...value, [question.questionId]: selectedKeys }));
    setSaveMessage("正在保存…");
    const response = await fetch(`/api/exam/attempt/${attemptId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: question.questionId, selectedKeys }),
    });
    setSaveMessage(response.ok ? "已自动保存" : "保存失败，请重试");
  }

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSaveMessage("正在交卷并评分…");
    const response = await fetch(`/api/exam/attempt/${attemptId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const result = await response.json() as { ok: boolean; message?: string };
    if (result.ok) window.location.assign("/employee/results");
    else { setSaveMessage(result.message ?? "交卷失败"); setSubmitting(false); }
  }, [attemptId]);

  useEffect(() => {
    if (!attempt) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((new Date(attempt.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !autoSubmittedRef.current) {
        autoSubmittedRef.current = true;
        void submit();
      }
    };
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [attempt, submit]);

  return <main className="exam-runner">
    <Watermark name={attempt?.watermarkName ?? ""} opacity={attempt?.watermarkOpacity ?? 0.07} />
    <header><div><span>入职学习考试</span><strong>{saveMessage}</strong></div><time className={remaining < 300 ? "urgent" : ""}>{displayTime}</time></header>
    <section className="exam-questions">
      {attempt?.questions.map((question) => <article key={question.questionId}>
        <div className="question-heading"><span>{String(question.displayOrder).padStart(2, "0")}</span><div><small>{question.type === "MULTIPLE" ? "多选题" : question.type === "TRUE_FALSE" ? "判断题" : "单选题"} · {question.score} 分</small><h2>{question.prompt}</h2></div></div>
        <div className="answer-options">{question.options.map((option) => {
          const checked = (answers[question.questionId] ?? []).includes(option.key);
          return <label className={checked ? "selected" : ""} key={option.key}><input type={question.type === "MULTIPLE" ? "checkbox" : "radio"} name={question.questionId} checked={checked} onChange={() => void select(question, option.key)} /><strong>{option.key}</strong><span>{option.text}</span></label>;
        })}</div>
      </article>)}
    </section>
    <footer><span>已作答 {Object.values(answers).filter((keys) => keys.length).length} / {attempt?.questions.length ?? 0}</span><button className="primary-action" type="button" disabled={submitting} onClick={() => void submit()}>提交试卷</button></footer>
  </main>;
}

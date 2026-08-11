"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { QuestionBankQuestionType } from "@/generated/prisma/enums";
import type { SafeTaskQuestion, TaskAnswerResponse } from "@/features/exam-task-runtime/types";
import { Watermark } from "@/lib/ui/watermark";

type Attempt = {
  attemptId: string;
  taskName: string;
  expiresAt: string;
  questions: SafeTaskQuestion[];
  answers: Record<string, TaskAnswerResponse>;
  watermarkName: string;
  watermarkOpacity: number;
};

function answered(response: TaskAnswerResponse | undefined): boolean {
  if (!response) return false;
  return "values" in response
    ? response.values.some((value) => value.trim().length > 0)
    : response.selectedOptionIds.length > 0;
}

export function TaskRunner({ attemptId }: { attemptId: string }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, TaskAnswerResponse>>({});
  const [remaining, setRemaining] = useState(0);
  const [saveMessage, setSaveMessage] = useState("正在加载试卷…");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [failedQuestionId, setFailedQuestionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closed, setClosed] = useState(false);
  const answersRef = useRef(answers);
  const timersRef = useRef(new Map<string, number>());
  const savePromisesRef = useRef(new Set<Promise<boolean>>());
  const autoSubmittedRef = useRef(false);

  useEffect(() => { answersRef.current = answers; }, [answers]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/exam/task-attempts/${attemptId}/answer`, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as Attempt & { ok?: boolean; code?: string; message?: string };
        if (!response.ok || !result.ok) {
          if (result.code === "ATTEMPT_CLOSED" || result.code === "TASK_ENDED") {
            setClosed(true);
          }
          setSaveMessage(result.message ?? "试卷加载失败");
          return;
        }
        setAttempt(result);
        setAnswers(result.answers ?? {});
        setRemaining(Math.max(0, Math.ceil((new Date(result.expiresAt).getTime() - Date.now()) / 1000)));
        setSaveMessage("");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSaveMessage("试卷加载失败，请刷新重试");
        }
      });
    return () => controller.abort();
  }, [attemptId]);

  const persist = useCallback(async (questionId: string, response: TaskAnswerResponse) => {
    setSaveMessage("正在自动保存…");
    const request = fetch(`/api/exam/task-attempts/${attemptId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, response }),
    }).then(async (httpResponse) => {
      if (!httpResponse.ok) {
        const result = (await httpResponse.json()) as { message?: string };
        throw new Error(result.message ?? "保存失败");
      }
      return true;
    });
    savePromisesRef.current.add(request);
    try {
      const saved = await request;
      setFailedQuestionId(null);
      setLastSavedAt(new Date());
      setSaveMessage("已自动保存");
      return saved;
    } catch (error) {
      setFailedQuestionId(questionId);
      setSaveMessage(error instanceof Error ? `${error.message}，请重试` : "保存失败，请重试");
      return false;
    } finally {
      savePromisesRef.current.delete(request);
    }
  }, [attemptId]);

  function updateAnswer(questionId: string, response: TaskAnswerResponse, debounce = false) {
    setAnswers((current) => ({ ...current, [questionId]: response }));
    const existing = timersRef.current.get(questionId);
    if (existing) window.clearTimeout(existing);
    if (debounce) {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(questionId);
        void persist(questionId, response);
      }, 800);
      timersRef.current.set(questionId, timer);
    } else {
      void persist(questionId, response);
    }
  }

  const flushPending = useCallback(async () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    const pendingQuestionIds = [...timersRef.current.keys()];
    timersRef.current.clear();
    const direct = pendingQuestionIds.map((questionId) =>
      persist(questionId, answersRef.current[questionId] ?? { selectedOptionIds: [] }),
    );
    const inFlight = [...savePromisesRef.current];
    const results = await Promise.all([...direct, ...inFlight]);
    return results.every(Boolean);
  }, [persist]);

  const submit = useCallback(async (skipFlush = false) => {
    if (submitting) return;
    setSubmitting(true);
    if (skipFlush) {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      setSaveMessage("考试到期，正在提交最后一次成功保存的答案…");
      await Promise.allSettled([...savePromisesRef.current]);
    } else {
      setSaveMessage("正在保存最后答案并交卷…");
      const saved = await flushPending();
      if (!saved) {
        setSaveMessage("仍有答案保存失败，请重试保存后再交卷");
        setSubmitting(false);
        return;
      }
    }
    try {
      const response = await fetch(`/api/exam/task-attempts/${attemptId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as { ok?: boolean; message?: string };
      if (response.ok && result.ok) {
        window.location.assign("/employee/results");
        return;
      }
      setSaveMessage(result.message ?? "交卷失败");
    } catch {
      setSaveMessage("交卷请求失败，请重试");
    }
    setSubmitting(false);
  }, [attemptId, flushPending, submitting]);

  useEffect(() => {
    if (!attempt) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((new Date(attempt.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !autoSubmittedRef.current) {
        autoSubmittedRef.current = true;
        void submit(true);
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [attempt, submit]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (timersRef.current.size || savePromisesRef.current.size) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const displayTime = useMemo(
    () => `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`,
    [remaining],
  );

  if (closed) {
    return (
      <main className="exam-runner task-exam-runner">
        <section className="task-attempt-closed" role="status">
          <h1>{saveMessage}</h1>
          <p>系统已保留最后一次成功保存的答案。</p>
          <a className="primary-action" href="/employee/results">查看考试结果</a>
        </section>
      </main>
    );
  }

  return (
    <main className="exam-runner task-exam-runner">
      <Watermark name={attempt?.watermarkName ?? ""} opacity={attempt?.watermarkOpacity ?? 0.07} />
      <header>
        <div>
          <span>{attempt?.taskName ?? "考试任务"}</span>
          <strong>
            {saveMessage}
            {lastSavedAt ? ` · 最后保存 ${lastSavedAt.toLocaleTimeString("zh-CN")}` : ""}
          </strong>
        </div>
        {failedQuestionId ? (
          <button type="button" onClick={() => void persist(failedQuestionId, answersRef.current[failedQuestionId] ?? { selectedOptionIds: [] })}>
            重试保存
          </button>
        ) : null}
        <time className={remaining < 300 ? "urgent" : ""}>{displayTime}</time>
      </header>
      <section className="exam-questions">
        {attempt?.questions.map((question) => {
          const response = answers[question.id];
          return (
            <article key={question.id}>
              <div className="question-heading">
                <span>{String(question.sequence).padStart(2, "0")}</span>
                <div>
                  <small>
                    {question.type === QuestionBankQuestionType.MULTIPLE_CHOICE
                      ? "多选题"
                      : question.type === QuestionBankQuestionType.FILL_BLANK
                        ? "填空题"
                        : "单选题"} · {question.score} 分
                  </small>
                  <h2>{question.prompt}</h2>
                </div>
              </div>
              {question.type === QuestionBankQuestionType.FILL_BLANK ? (
                <div className="fill-answer-list">
                  {Array.from({ length: question.blankCount }, (_, index) => {
                    const values = response && "values" in response
                      ? response.values
                      : Array.from({ length: question.blankCount }, () => "");
                    return (
                      <label key={index}>
                        第 {index + 1} 空
                        <input
                          value={values[index] ?? ""}
                          onChange={(event) => {
                            const next = [...values];
                            next[index] = event.target.value;
                            updateAnswer(question.id, { values: next }, true);
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="answer-options">
                  {question.options.map((option) => {
                    const selected = response && "selectedOptionIds" in response
                      ? response.selectedOptionIds
                      : [];
                    const checked = selected.includes(option.id);
                    return (
                      <label className={checked ? "selected" : ""} key={option.id}>
                        <input
                          type={question.type === QuestionBankQuestionType.MULTIPLE_CHOICE ? "checkbox" : "radio"}
                          name={question.id}
                          checked={checked}
                          onChange={() => {
                            const next = question.type === QuestionBankQuestionType.MULTIPLE_CHOICE
                              ? checked ? selected.filter((id) => id !== option.id) : [...selected, option.id]
                              : [option.id];
                            updateAnswer(question.id, { selectedOptionIds: next });
                          }}
                        />
                        <strong>{option.label}</strong><span>{option.text}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </section>
      <footer>
        <span>已作答 {Object.values(answers).filter(answered).length} / {attempt?.questions.length ?? 0}</span>
        <button className="primary-action" type="button" disabled={submitting || !attempt} onClick={() => void submit()}>
          {submitting ? "正在交卷…" : "提交试卷"}
        </button>
      </footer>
    </main>
  );
}

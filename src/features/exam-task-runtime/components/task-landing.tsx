"use client";

import { useEffect, useState } from "react";

import { ExamLanding } from "@/features/exams/components/exam-landing";

type TaskItem = {
  id: string;
  displayStatus: string;
  currentAttemptCount: number;
  score: number | null;
  task: {
    name: string;
    description: string | null;
    startsAt: string;
    endsAt: string;
    passingScore: number;
    questionBankName: string;
    questionBankVersion: number;
    questionCount: number;
    totalScore: number;
  };
  latestAttempt: { id: string; canContinue: boolean } | null;
};

const statusLabels: Record<string, string> = {
  UPCOMING: "未开始",
  PENDING: "待完成",
  IN_PROGRESS: "进行中",
  PASSED: "已通过",
  FAILED: "已完成 · 未通过",
  RETAKE_READY: "待补考",
  APPLICATION_REQUIRED: "需要申请补考",
  PENDING_APPROVAL: "补考申请待审批",
  OVERDUE: "已过期未完成",
};

function formatShanghai(value: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function TaskLanding({
  isManagementAccount,
  hasLegacyAssignment,
}: {
  isManagementAccount: boolean;
  hasLegacyAssignment: boolean;
}) {
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [message, setMessage] = useState("正在加载考试任务…");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function load() {
    try {
      const response = await fetch("/api/exam/tasks");
      const result = (await response.json()) as { ok?: boolean; tasks?: TaskItem[]; message?: string };
      if (!response.ok || !result.ok) {
        setTasks([]);
        setMessage(result.message ?? "考试任务加载失败");
        return;
      }
      setTasks(result.tasks ?? []);
      setMessage("");
    } catch {
      setTasks([]);
      setMessage("考试任务加载失败，请刷新重试");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/exam/tasks", { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as { ok?: boolean; tasks?: TaskItem[]; message?: string };
        if (!response.ok || !result.ok) {
          setTasks([]);
          setMessage(result.message ?? "考试任务加载失败");
          return;
        }
        setTasks(result.tasks ?? []);
        setMessage("");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setTasks([]);
          setMessage("考试任务加载失败，请刷新重试");
        }
      });
    return () => controller.abort();
  }, []);

  async function start(task: TaskItem) {
    if (busyId) return;
    setBusyId(task.id);
    setMessage("正在进入考试…");
    try {
      if (task.latestAttempt?.canContinue) {
        window.location.assign(`/employee/exam/task-attempt/${task.latestAttempt.id}`);
        return;
      }
      const response = await fetch(`/api/exam/tasks/${task.id}/start`, { method: "POST" });
      const result = (await response.json()) as { ok?: boolean; attemptId?: string; message?: string };
      if (response.ok && result.ok && result.attemptId) {
        window.location.assign(`/employee/exam/task-attempt/${result.attemptId}`);
        return;
      }
      setMessage(result.message ?? "暂时无法开始考试");
    } catch {
      setMessage("进入考试失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  async function apply(task: TaskItem) {
    const reason = reasons[task.id] ?? "";
    setBusyId(task.id);
    try {
      const response = await fetch("/api/exam/task-retakes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId: task.id, reason }),
      });
      const result = (await response.json()) as { ok?: boolean; message?: string };
      setMessage(result.ok ? "补考申请已提交" : result.message ?? "补考申请失败");
      if (result.ok) await load();
    } catch {
      setMessage("补考申请失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  if (tasks === null) {
    return <main className="employee-content"><p className="status-message">{message}</p></main>;
  }
  if (!tasks.length) {
    return (
      <>
        {message ? <p className="status-message">{message}</p> : null}
        <ExamLanding
          isManagementAccount={isManagementAccount}
          hasAssignment={hasLegacyAssignment}
        />
      </>
    );
  }

  return (
    <main className="employee-content exam-task-landing">
      <header className="employee-hero">
        <p className="eyebrow">EXAM · 入职学习考试</p>
        <h1>我的考试任务</h1>
        <p>答案自动保存；开始、保存和提交均由服务器校验时间与账号归属。</p>
      </header>
      <p className="status-message" role="status">{message}</p>
      <section className="employee-task-list">
        {tasks.map((task) => {
          const canStart = ["PENDING", "IN_PROGRESS", "RETAKE_READY"].includes(task.displayStatus);
          return (
            <article key={task.id} className="employee-task-card">
              <header>
                <div>
                  <span className={`task-status task-status-${task.displayStatus.toLowerCase()}`}>
                    {statusLabels[task.displayStatus] ?? task.displayStatus}
                  </span>
                  <h2>{task.task.name}</h2>
                  <p>{task.task.description ?? "请在规定时间内完成考试。"}</p>
                </div>
                {task.score !== null ? <strong className="task-score">{task.score}</strong> : null}
              </header>
              <dl>
                <div><dt>题库</dt><dd>{task.task.questionBankName} · v{task.task.questionBankVersion}</dd></div>
                <div><dt>题目</dt><dd>{task.task.questionCount} 题 · 满分 {task.task.totalScore}</dd></div>
                <div><dt>及格</dt><dd>{task.task.passingScore} 分</dd></div>
                <div><dt>开始</dt><dd>{formatShanghai(task.task.startsAt)}</dd></div>
                <div><dt>截止</dt><dd>{formatShanghai(task.task.endsAt)}</dd></div>
                <div><dt>次数</dt><dd>已使用 {task.currentAttemptCount} 次</dd></div>
              </dl>
              {task.displayStatus === "APPLICATION_REQUIRED" ? (
                <div className="task-retake-form">
                  <textarea
                    value={reasons[task.id] ?? ""}
                    onChange={(event) => setReasons((current) => ({ ...current, [task.id]: event.target.value }))}
                    placeholder="请说明复习情况与补考原因（至少 10 个字符）"
                    rows={3}
                  />
                  <button
                    type="button"
                    disabled={busyId === task.id || (reasons[task.id] ?? "").trim().length < 10}
                    onClick={() => void apply(task)}
                  >提交补考申请</button>
                </div>
              ) : null}
              <footer>
                {canStart ? (
                  <button
                    className="primary-action"
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => void start(task)}
                  >
                    {busyId === task.id ? "正在进入…" : task.displayStatus === "IN_PROGRESS" ? "继续考试" : task.displayStatus === "RETAKE_READY" ? "开始补考" : "开始考试"}
                  </button>
                ) : ["PASSED", "FAILED"].includes(task.displayStatus) ? (
                  <a className="button-link" href="/employee/results">查看结果</a>
                ) : null}
              </footer>
            </article>
          );
        })}
      </section>
    </main>
  );
}

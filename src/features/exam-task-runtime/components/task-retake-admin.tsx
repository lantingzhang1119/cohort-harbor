"use client";

import { useCallback, useEffect, useState } from "react";

type Application = {
  id: string;
  reason: string;
  createdAt: string;
  requester: { employeeNo: string; name: string; firstDepartment: string | null };
  assignment: { task: { name: string; endsAt: string } };
};

export function TaskRetakeAdmin() {
  const [items, setItems] = useState<Application[]>([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/exam-task-retakes");
    const result = (await response.json()) as { applications?: Application[]; message?: string };
    setItems(result.applications ?? []);
    setMessage(result.applications?.length ? "" : result.message ?? "暂无新考试任务补考申请");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/exam-task-retakes", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { applications?: Application[]; message?: string }) => {
        setItems(result.applications ?? []);
        setMessage(result.applications?.length ? "" : result.message ?? "暂无新考试任务补考申请");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("补考申请加载失败");
        }
      });
    return () => controller.abort();
  }, []);

  async function review(id: string, approve: boolean) {
    const response = await fetch(`/api/admin/exam-task-retakes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    const result = (await response.json()) as { ok?: boolean; message?: string };
    setMessage(result.ok ? (approve ? "补考申请已通过" : "补考申请已拒绝") : result.message ?? "审批失败");
    if (result.ok) await load();
  }

  return (
    <section className="task-retake-admin-section">
      <h2>批量考试任务补考申请</h2>
      <p className="status-message">{message}</p>
      <div className="retake-admin-list">
        {items.map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.requester.name}</strong>
              <span>{item.requester.employeeNo} · {item.requester.firstDepartment ?? "未设置部门"}</span>
              <p>{item.reason}</p>
            </div>
            <span>{item.assignment.task.name} · 截止 {new Date(item.assignment.task.endsAt).toLocaleString("zh-CN")}</span>
            <div>
              <button type="button" onClick={() => void review(item.id, false)}>拒绝</button>
              <button type="button" onClick={() => void review(item.id, true)}>通过</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

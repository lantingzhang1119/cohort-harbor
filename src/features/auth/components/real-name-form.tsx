"use client";

import { FormEvent, useState } from "react";

type ProfileResponse = {
  ok?: boolean;
  name?: string;
  redirectTo?: "/admin/settings" | "/employee";
  message?: string;
};

export function RealNameForm({
  initialName,
  required = false,
}: {
  initialName: string;
  required?: boolean;
}) {
  const [name, setName] = useState(required ? "" : initialName);
  const [message, setMessage] = useState(
    required ? "请先完成真实姓名设置，再进入员工端。" : "",
  );
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.json() as ProfileResponse;
      if (!response.ok || !result.ok) {
        setMessage(result.message ?? "姓名保存失败，请稍后重试");
        return;
      }
      setName(result.name ?? name);
      setMessage("真实姓名已保存");
      if (result.redirectTo) window.location.assign(result.redirectTo);
    } catch {
      setMessage("姓名保存失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="real-name-form" onSubmit={(event) => void submit(event)}>
      <label>
        真实姓名
        <input
          autoComplete="name"
          maxLength={80}
          minLength={2}
          name="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p>该姓名会显示在员工端顶部和“{name || "示例员工"}，欢迎开启入职学习旅程”中。</p>
      <button className="primary-action" disabled={submitting} type="submit">
        {submitting ? "正在保存…" : "保存真实姓名"}
      </button>
      <span aria-live="polite" role={message.includes("失败") ? "alert" : "status"}>{message}</span>
    </form>
  );
}

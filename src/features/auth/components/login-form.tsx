"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export function LoginForm() {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: data.get("identifier"),
          password: data.get("password"),
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        redirectTo?: string;
        message?: string;
      };
      if (result.ok && result.redirectTo) window.location.assign(result.redirectTo);
      else setMessage(result.message ?? "登录未能完成，请稍后重试");
    } catch {
      setMessage("无法连接本地服务，请确认平台已启动");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="field-group">
        <label htmlFor="identifier">姓名 / 工号</label>
        <input
          id="identifier"
          name="identifier"
          autoComplete="username"
          placeholder="请输入姓名或员工工号"
          required
        />
        <p className="field-help">如有同名员工，请使用工号登录。</p>
      </div>
      <div className="field-group">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="请输入密码"
          required
        />
      </div>
      <Link href="/forgot-password">忘记密码？</Link>
      <p className="form-message" role="alert" aria-live="polite">
        {message}
      </p>
      <button className="primary-action auth-submit" disabled={submitting} type="submit">
        {submitting ? "正在登录…" : "登录平台"}
      </button>
    </form>
  );
}

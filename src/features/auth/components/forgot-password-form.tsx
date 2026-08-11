"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

type ForgotPasswordResult = {
  ok: boolean;
  message?: string;
  developmentPreview?: { label: string; url: string };
};

export function ForgotPasswordForm() {
  const [result, setResult] = useState<ForgotPasswordResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: data.get("identifier") }),
      });
      setResult((await response.json()) as ForgotPasswordResult);
    } catch {
      setResult({ ok: false, message: "无法连接本地服务，请稍后重试" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="field-group">
        <label htmlFor="identifier">邮箱或工号</label>
        <input
          id="identifier"
          name="identifier"
          autoComplete="username"
          placeholder="请输入账号邮箱或员工工号"
          required
        />
      </div>
      <p className="form-message" role="status" aria-live="polite">
        {result?.message}
      </p>
      {result?.developmentPreview && (
        <aside className="auth-note" aria-label={result.developmentPreview.label}>
          <strong>{result.developmentPreview.label}</strong>
          <p>仅用于本地开发验证，正式环境不会显示此链接。</p>
          <Link href={result.developmentPreview.url}>打开模拟重置链接</Link>
        </aside>
      )}
      <button className="primary-action auth-submit" disabled={submitting} type="submit">
        {submitting ? "正在提交…" : "发送重置邮件"}
      </button>
      <Link href="/login">返回登录</Link>
    </form>
  );
}

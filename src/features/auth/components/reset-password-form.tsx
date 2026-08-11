"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { validateNewPassword } from "@/features/auth/password-policy";

export function ResetPasswordForm({ token }: { token: string }) {
  const [message, setMessage] = useState(token ? "" : "密码重置链接无效");
  const [completed, setCompleted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword") ?? "");
    if (newPassword !== data.get("confirmPassword")) {
      setMessage("两次输入的新密码不一致");
      return;
    }
    const validation = validateNewPassword(newPassword);
    if (!validation.success) {
      setMessage(validation.error.issues[0]?.message ?? "新密码格式无效");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const result = (await response.json()) as { ok: boolean; message?: string };
      setCompleted(result.ok);
      setMessage(result.message ?? "密码重置未能完成");
    } catch {
      setMessage("无法连接本地服务，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="field-group">
        <label htmlFor="newPassword">新密码</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          pattern="(?=.*[A-Za-z])(?=.*\d).{8,}"
          required
          disabled={!token || completed}
        />
        <p className="field-help">至少 8 位，必须同时包含英文字母和数字。</p>
      </div>
      <div className="field-group">
        <label htmlFor="confirmPassword">确认新密码</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          disabled={!token || completed}
        />
      </div>
      <p className="form-message" role="alert" aria-live="polite">{message}</p>
      {!completed && (
        <button className="primary-action auth-submit" disabled={!token || submitting} type="submit">
          {submitting ? "正在重置…" : "设置新密码"}
        </button>
      )}
      <Link href="/login">{completed ? "使用新密码登录" : "返回登录"}</Link>
    </form>
  );
}

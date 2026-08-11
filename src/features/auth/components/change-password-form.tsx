"use client";

import { useState, type FormEvent } from "react";

import { validateNewPassword } from "@/features/auth/password-policy";

export function ChangePasswordForm() {
  const [message, setMessage] = useState("");
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
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        redirectTo?: string;
        message?: string;
      };
      if (result.ok && result.redirectTo) window.location.assign(result.redirectTo);
      else setMessage(result.message ?? "密码修改未能完成");
    } catch {
      setMessage("无法连接本地服务，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="field-group">
        <label htmlFor="currentPassword">当前密码</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
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
        />
        <p className="field-help">至少 8 位，必须同时包含英文字母和数字，且不能与当前密码相同。</p>
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
        />
      </div>
      <p className="form-message" role="alert" aria-live="polite">
        {message}
      </p>
      <button className="primary-action auth-submit" disabled={submitting} type="submit">
        {submitting ? "正在保存…" : "保存并进入平台"}
      </button>
    </form>
  );
}

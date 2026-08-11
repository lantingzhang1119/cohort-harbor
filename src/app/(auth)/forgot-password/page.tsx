import type { Metadata } from "next";

import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";

export const metadata: Metadata = { title: "找回密码" };

export default function ForgotPasswordPage() {
  return (
    <main className="auth-shell single-auth-shell">
      <section className="auth-card" aria-labelledby="forgot-password-title">
        <div className="auth-heading">
          <span className="auth-step">02</span>
          <div>
            <p>账号恢复</p>
            <h1 id="forgot-password-title">找回密码</h1>
          </div>
        </div>
        <p className="auth-intro">提交后请查收账号邮箱；为保护账号，页面不会显示账号是否存在。</p>
        <ForgotPasswordForm />
      </section>
    </main>
  );
}

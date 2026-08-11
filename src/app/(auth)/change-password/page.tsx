import type { Metadata } from "next";

import { ChangePasswordForm } from "@/features/auth/components/change-password-form";

export const metadata: Metadata = { title: "设置新密码" };

export default function ChangePasswordPage() {
  return (
    <main className="auth-shell single-auth-shell">
      <section className="auth-card" aria-labelledby="change-password-title">
        <div className="auth-heading">
          <span className="auth-step">02</span>
          <div>
            <p>首次登录安全设置</p>
            <h1 id="change-password-title">设置你的新密码</h1>
          </div>
        </div>
        <p className="auth-intro">初始密码只能用于首次登录。设置完成后即可进入学习平台。</p>
        <ChangePasswordForm />
      </section>
    </main>
  );
}

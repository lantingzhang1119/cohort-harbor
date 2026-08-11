import type { Metadata } from "next";

import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

export const metadata: Metadata = { title: "重置密码" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <main className="auth-shell single-auth-shell">
      <section className="auth-card" aria-labelledby="reset-password-title">
        <div className="auth-heading">
          <span className="auth-step">03</span>
          <div>
            <p>账号恢复</p>
            <h1 id="reset-password-title">设置新密码</h1>
          </div>
        </div>
        <ResetPasswordForm token={token} />
      </section>
    </main>
  );
}

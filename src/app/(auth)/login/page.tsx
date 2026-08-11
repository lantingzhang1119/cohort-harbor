import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { LoginForm } from "@/features/auth/components/login-form";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <main className="auth-shell">
      <section className="auth-brand-panel" aria-label="平台介绍">
        <Link href="/" className="auth-logo-link" aria-label="返回平台首页">
          <Image
            src="/brand/cohort-harbor-mark.svg"
            alt={BRAND.name}
            width={466}
            height={254}
            priority
          />
        </Link>
        <div>
          <p className="eyebrow">WELCOME ABOARD</p>
          <h1>入职学习，从登录开始</h1>
          <p>在一个清晰的空间里完成入职学习、制度阅读与入职考试。</p>
        </div>
        <span className="auth-panel-star" aria-hidden="true">✦</span>
      </section>
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-heading">
          <span className="auth-step">01</span>
          <div>
            <p>员工入口</p>
            <h2 id="login-title">登录平台</h2>
          </div>
        </div>
        <LoginForm />
        <p className="auth-note">本地 Demo 不连接公司 OA，账号由管理员创建或从 Excel 导入。</p>
      </section>
    </main>
  );
}

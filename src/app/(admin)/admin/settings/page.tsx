import { BookOpenText, ClipboardCheck, Database, MailWarning, MapPinned } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { RealNameForm } from "@/features/auth/components/real-name-form";
import { isReservedDisplayName } from "@/features/auth/real-name";
import { ModuleSettings } from "@/features/employee-modules/components/module-settings";
import { getEnabledEmployeeModules } from "@/features/employee-modules/module-service";
import { requirePageUser } from "@/lib/auth/server-session";
import { prisma } from "@/lib/db/client";

export const metadata: Metadata = { title: "系统设置" };

export default async function SettingsPage() {
  const [settings, user, enabledModules] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { id: "default" } }),
    requirePageUser("ADMIN_ACCESS"),
    getEnabledEmployeeModules(prisma),
  ]);
  const realNameRequired = isReservedDisplayName(user.name);

  return (
    <main className="admin-content">
      <header className="page-title-row">
        <div>
          <p className="eyebrow">SYSTEM · 本地配置</p>
          <h1>系统设置</h1>
          <p>维护个人资料并进入各业务模块调整配置。</p>
        </div>
      </header>

      <section className={`profile-settings-card${realNameRequired ? " required" : ""}`}>
        <header>
          <div><p className="eyebrow">MY PROFILE</p><h2>管理员真实姓名</h2></div>
          <span>{realNameRequired ? "切换员工端前必填" : "已设置"}</span>
        </header>
        <RealNameForm initialName={user.name} required={realNameRequired} />
      </section>

      <ModuleSettings initialEnabledKeys={[...enabledModules]} />

      <section className="settings-grid">
        <Link href="/admin/exam-settings"><ClipboardCheck /><div><strong>考试设置</strong><span>时长、及格线、截止天数与错题显示</span></div></Link>
        <Link href="/admin/guides"><MapPinned /><div><strong>城市指南</strong><span>启停四城内容并维护摘要</span></div></Link>
        <Link href="/admin/policies"><BookOpenText /><div><strong>制度文件</strong><span>上传、发布与归档 PDF</span></div></Link>
      </section>

      <section className="demo-boundaries">
        <header><Database /><div><h2>当前本地 Demo 配置</h2><p>所有数据和文件只保存在本机工作目录。</p></div></header>
        <dl>
          <div><dt>默认考试时长</dt><dd>{settings?.defaultExamMinutes ?? 30} 分钟</dd></div>
          <div><dt>默认截止天数</dt><dd>{settings?.defaultDueDays ?? 7} 天</dd></div>
          <div><dt>水印透明度</dt><dd>{settings?.watermarkOpacity ?? 0.07}</dd></div>
          <div><dt>外部连接</dt><dd>全部关闭</dd></div>
        </dl>
        <p><MailWarning size={18} /> 邮件催办为模拟日志，不连接 SMTP；花名册来源为本地 Excel，不连接 OA。</p>
      </section>
    </main>
  );
}

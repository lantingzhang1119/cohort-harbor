import { Bell, BookOpenText, CheckCircle2, ChevronRight, ClipboardCheck, Compass, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { getEmployeeDashboard } from "@/features/dashboard/dashboard-service";
import { EmployeeModuleGate, EmployeeModuleQuickLinks } from "@/features/employee-modules/components/module-visibility";
import { requirePageUser } from "@/lib/auth/server-session";
import { prisma } from "@/lib/db/client";
import { Watermark } from "@/lib/ui/watermark";

export const metadata: Metadata = { title: "我的学习首页" };

const statusLabel: Record<string, string> = {
  NOT_STARTED: "等待开启",
  IN_PROGRESS: "正在充电",
  FAILED: "本次未通过",
  RETAKE_READY: "可以直接补考",
  APPLICATION_REQUIRED: "需要申请补考",
  PENDING_APPROVAL: "补考审批中",
  PASSED: "已完成充电",
  OVERDUE: "任务已逾期",
};

export default async function EmployeeDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ notice?: string }>;
}) {
  const user = await requirePageUser("EMPLOYEE_VIEW_ACCESS");
  const query = await searchParams;
  const [dashboard, setting] = await Promise.all([
    getEmployeeDashboard(prisma, user.id),
    prisma.systemSetting.findUnique({ where: { id: "default" }, select: { watermarkOpacity: true } }),
  ]);
  const progress = dashboard.assignment?.status === "PASSED" ? 100 : dashboard.assignment?.status === "IN_PROGRESS" ? 62 : dashboard.assignment ? 28 : 0;

  return (
    <main className="employee-content employee-dashboard">
      <Watermark name={user.name} opacity={setting?.watermarkOpacity ?? 0.07} />
      {query?.notice === "module-closed" ? <p className="module-closed-notice" role="status">该板块当前未开放</p> : null}
      <section className="employee-welcome">
        <div><p className="eyebrow">WELCOME TO CohortHarbor</p><h1 className={user.name.length > 12 ? "long-name" : undefined}>{user.name}，欢迎开启入职学习旅程</h1><p>今天也一起点亮新的知识节点，完成你的入职学习地图。</p></div>
        <div className="charging-orbit" aria-hidden="true"><span>✦</span><i>H</i><b>✦</b></div>
      </section>
      <section className="employee-stat-strip">
        <EmployeeModuleGate moduleKey={EmployeeModuleKey.GUIDES}><article><Compass aria-hidden="true" /><div><strong>{dashboard.guideCount}</strong><span>城市指南</span></div></article></EmployeeModuleGate>
        <EmployeeModuleGate moduleKey={EmployeeModuleKey.POLICIES}><article><BookOpenText aria-hidden="true" /><div><strong>{dashboard.viewedPolicies}/{dashboard.publishedPolicies}</strong><span>制度已阅读</span></div></article></EmployeeModuleGate>
        <EmployeeModuleGate moduleKey={EmployeeModuleKey.NOTIFICATIONS}><article><Bell aria-hidden="true" /><div><strong>{dashboard.unreadNotifications}</strong><span>未读通知</span></div></article></EmployeeModuleGate>
      </section>
      <EmployeeModuleQuickLinks />
      <div className="employee-dashboard-grid">
        <EmployeeModuleGate moduleKey={EmployeeModuleKey.EXAM}><section className="charging-card">
          <header><div><p className="eyebrow">CHARGING PLAN</p><h2>入职学习考试</h2></div><ClipboardCheck aria-hidden="true" /></header>
          {dashboard.assignment ? <>
            <div className="charging-progress"><div><i style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div>
            <div className="assignment-summary"><span>{statusLabel[dashboard.assignment.status] ?? dashboard.assignment.status}</span><h3>{dashboard.assignment.examName}</h3><p>及格线 {dashboard.assignment.passingScore} 分 · {dashboard.assignment.source === "TASK" ? `考试窗口 ${dashboard.assignment.startsAt.toLocaleString("zh-CN")} 至 ${dashboard.assignment.dueAt.toLocaleString("zh-CN")}` : `限时 ${dashboard.assignment.durationMinutes} 分钟 · 截止 ${dashboard.assignment.dueAt.toLocaleDateString("zh-CN")}`}</p></div>
            <Link className="primary-action" href="/employee/exam">继续学习 <ChevronRight aria-hidden="true" size={18} /></Link>
          </> : <p className="empty-note">管理员尚未发布考试任务。</p>}
        </section></EmployeeModuleGate>
        <section className="journey-card">
          <header><div><p className="eyebrow">MY JOURNEY</p><h2>入职成长路线</h2></div><Sparkles aria-hidden="true" /></header>
          <ol>
            <EmployeeModuleGate moduleKey={EmployeeModuleKey.GUIDES}><li className="done"><CheckCircle2 aria-hidden="true" /><div><strong>认识工作城市</strong><span>查阅交通、办公与生活指南</span></div><Link href="/employee/guides">查看</Link></li></EmployeeModuleGate>
            <EmployeeModuleGate moduleKey={EmployeeModuleKey.POLICIES}><li className={dashboard.viewedPolicies > 0 ? "done" : ""}><BookOpenText aria-hidden="true" /><div><strong>完成制度学习</strong><span>阅读本岗位适用的公司制度</span></div><Link href="/employee/policies">查看</Link></li></EmployeeModuleGate>
            <EmployeeModuleGate moduleKey={EmployeeModuleKey.EXAM}><li className={dashboard.assignment?.status === "PASSED" ? "done" : ""}><ClipboardCheck aria-hidden="true" /><div><strong>通过入职学习考试</strong><span>检验制度与入职知识掌握情况</span></div><Link href="/employee/exam">开始</Link></li></EmployeeModuleGate>
          </ol>
        </section>
      </div>
    </main>
  );
}

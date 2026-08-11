import { BellRing, CircleCheckBig, MapPinOff, UserRoundCheck, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { getAdminDashboard } from "@/features/dashboard/dashboard-service";
import { prisma } from "@/lib/db/client";

export const metadata: Metadata = { title: "运营看板" };

const statusLabels: Record<string, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  FAILED: "未通过",
  RETAKE_READY: "可直接补考",
  APPLICATION_REQUIRED: "需申请补考",
  PENDING_APPROVAL: "待审批",
  PASSED: "已通过",
  OVERDUE: "已逾期",
};

export default async function AdminDashboardPage() {
  const dashboard = await getAdminDashboard(prisma);
  const statusTotal = Object.values(dashboard.examStatuses).reduce((sum, value) => sum + value, 0);
  const metrics = [
    { label: "员工总数", value: dashboard.employees.total, note: `${dashboard.employees.enabled} 人启用`, icon: UsersRound, tone: "blue", href: "/admin/employees" },
    { label: "账号启用", value: dashboard.employees.enabled, note: `${dashboard.employees.disabled} 人停用`, icon: UserRoundCheck, tone: "teal", href: "/admin/employees?enabled=true" },
    { label: "考试通过率", value: `${dashboard.passRate}%`, note: `${statusTotal} 个考试任务`, icon: CircleCheckBig, tone: "green", href: "/admin/results" },
    { label: "待审批补考", value: dashboard.pendingRetakes, note: "需要管理员处理", icon: BellRing, tone: "orange", href: "/admin/retakes?status=PENDING" },
    { label: "地点未设置", value: dashboard.employees.unsetLocation, note: "可在员工管理批量补充", icon: MapPinOff, tone: "purple", href: "/admin/employees?location=UNSET" },
  ];

  return (
    <main className="admin-content dashboard-page">
      <header className="dashboard-heading">
        <div><p className="eyebrow">CONTROL CENTER · 运营总览</p><h1>入职学习看板</h1><p>仅展示聚合指标，不在看板日志中展开员工个人信息。</p></div>
        <Link className="primary-action" href="/admin/reminders">处理学习待办</Link>
      </header>
      <section className="metric-grid" aria-label="核心指标">
        {metrics.map(({ label, value, note, icon: Icon, tone, href }) => (
          <Link className={`metric-card ${tone}`} href={href} key={label}>
            <span><Icon aria-hidden="true" size={21} /></span><p>{label}</p><strong>{value}</strong><small>{note}</small>
          </Link>
        ))}
      </section>
      <div className="dashboard-columns">
        <section className="dashboard-panel">
          <header><div><p className="eyebrow">EXAM STATUS</p><h2>考试任务分布</h2></div><Link href="/admin/results">查看结果 →</Link></header>
          <div className="status-bars">
            {Object.entries(dashboard.examStatuses).map(([status, count]) => (
              <Link href={`/admin/results?status=${status}`} key={status}><span>{statusLabels[status] ?? status}</span><div><i style={{ width: `${statusTotal === 0 ? 0 : Math.max(4, Math.round((count / statusTotal) * 100))}%` }} /></div><strong>{count}</strong></Link>
            ))}
          </div>
        </section>
        <section className="dashboard-panel">
          <header><div><p className="eyebrow">ROSTER IMPORTS</p><h2>最近导入</h2></div><Link href="/admin/roster/history">全部历史 →</Link></header>
          <div className="dashboard-imports">
            {dashboard.recentImports.length === 0 && <p className="empty-note">尚无花名册导入记录。</p>}
            {dashboard.recentImports.map((item) => (
              <Link href="/admin/roster/history" key={item.id}>
                <div><strong>{item.originalFileName}</strong><span>{item.sourceName} · {item.status}</span></div>
                <dl><div><dt>总行数</dt><dd>{item.totalRows}</dd></div><div><dt>新增</dt><dd>{item.createdCount}</dd></div><div><dt>更新</dt><dd>{item.updatedCount}</dd></div><div><dt>问题</dt><dd>{item.conflictCount + item.errorCount}</dd></div></dl>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

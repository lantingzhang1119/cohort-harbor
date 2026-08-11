import {
  BellRing,
  BookOpenText,
  Building2,
  ClipboardCheck,
  FileClock,
  Gauge,
  History,
  KeyRound,
  Mail,
  PackageOpen,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";

import { Role } from "@/generated/prisma/enums";

const sections = [
  { label: "总览", items: [{ href: "/admin", label: "运营看板", icon: Gauge }] },
  {
    label: "员工与花名册",
    items: [
      { href: "/admin/employees", label: "员工管理", icon: Users },
      { href: "/admin/roster/import", label: "导入花名册", icon: Building2 },
      { href: "/admin/roster/history", label: "导入历史", icon: History },
    ],
  },
  {
    label: "学习内容",
    items: [
      { href: "/admin/guides", label: "四城指南", icon: BookOpenText },
      { href: "/admin/onboarding-kit", label: "入职资料包", icon: PackageOpen },
      { href: "/admin/policies", label: "制度文件", icon: ShieldCheck },
      { href: "/admin/questions", label: "题库管理", icon: ClipboardCheck },
    ],
  },
  {
    label: "考试运营",
    items: [
      { href: "/admin/exam-tasks/new", label: "发布考试任务", icon: Send },
      { href: "/admin/results", label: "考试结果", icon: FileClock },
      { href: "/admin/retakes", label: "补考审批", icon: RotateCcw },
      { href: "/admin/reminders", label: "学习催办", icon: BellRing },
      { href: "/admin/onboarding-mail", label: "欢迎邮件", icon: Mail },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/admin/administrators", label: "管理员账号", icon: KeyRound },
      { href: "/admin/settings", label: "系统设置", icon: Settings },
      { href: "/admin/audit", label: "审计日志", icon: ShieldCheck },
    ],
  },
];

export function AdminSidebar({ role }: { role?: Role }) {
  return (
    <aside className="admin-sidebar" aria-label="管理员侧栏">
      <Link className="sidebar-brand" href="/admin">
        <span className="brand-chip">H</span>
        <span><strong>CohortHarbor</strong><small>入职学习平台</small></span>
      </Link>
      <nav>
        {sections.map((section) => (
          <section key={section.label}>
            <p>{section.label}</p>
            {section.items
              .filter(({ href }) => href !== "/admin/administrators" || role === Role.SUPER_ADMIN)
              .map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href}>
                <Icon aria-hidden="true" size={18} />
                <span>{label}</span>
              </Link>
              ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}

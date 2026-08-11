import type { Metadata } from "next";
import Link from "next/link";

import { requirePageUser } from "@/lib/auth/server-session";

export const metadata: Metadata = { title: "个人资料" };

const locationLabels: Record<string, string> = { SHANGHAI: "上海", SHENZHEN: "深圳", CHANGSHA: "长沙", XIAN: "西安", UNSET: "待设置" };

export default async function ProfilePage() {
  const user = await requirePageUser("EMPLOYEE_VIEW_ACCESS");
  const fields = [
    ["工号", user.employeeNo], ["姓名", user.name], ["邮箱", user.email ?? "未设置"],
    ["一级部门", user.firstDepartment ?? "未设置"], ["二级部门", user.secondDepartment ?? "未设置"],
    ["岗位", user.position ?? "未设置"], ["工作地点", locationLabels[user.workLocation]],
    ["入职日期", user.hiredAt?.toLocaleDateString("zh-CN") ?? "未设置"],
  ];
  return <main className="employee-content compact-content"><header className="employee-hero"><p className="eyebrow">MY PROFILE</p><h1>个人资料</h1><p>资料来自本地 Demo 数据库。如需修改，请联系管理员在员工管理中维护。</p><Link className="primary-action" href="/change-password">修改我的密码</Link></header><section className="profile-card">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</section></main>;
}

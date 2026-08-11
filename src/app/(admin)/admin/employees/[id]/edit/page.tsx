import type { Metadata } from "next";

import { EmployeeEditForm } from "@/features/employees/components/employee-edit-form";

export const metadata: Metadata = { title: "编辑员工" };

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="admin-content compact-content"><header className="page-title-row"><div><p className="eyebrow">PEOPLE · 账号维护</p><h1>编辑员工</h1><p>更新员工资料、工作地点、人员状态或重置初始密码。</p></div></header><EmployeeEditForm employeeId={id} /></main>;
}

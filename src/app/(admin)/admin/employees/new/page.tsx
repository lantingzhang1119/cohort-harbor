import type { Metadata } from "next";

import { NewEmployeeForm } from "@/features/employees/components/new-employee-form";

export const metadata: Metadata = { title: "新增员工" };

export default function NewEmployeePage() {
  return (
    <main className="admin-content compact-content">
      <header className="page-title-row"><div><p className="eyebrow">PEOPLE · 新账号</p><h1>新增员工</h1><p>员工首次登录后将被要求修改初始密码。</p></div></header>
      <NewEmployeeForm />
    </main>
  );
}

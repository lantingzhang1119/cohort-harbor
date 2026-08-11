"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export function NewEmployeeForm() {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/admin/employees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = (await response.json()) as { ok: boolean; message?: string };
    if (result.ok) window.location.assign("/admin/employees");
    else setMessage(result.message ?? "员工创建失败");
    setSaving(false);
  }

  return (
    <form className="employee-form" onSubmit={submit}>
      <div className="form-grid">
        <label><span>工号 *</span><input name="employeeNo" required /></label>
        <label><span>姓名 *</span><input name="name" required /></label>
        <label><span>邮箱 *</span><input name="email" type="email" required /></label>
        <label><span>入职日期 *</span><input name="hiredAt" type="date" required /></label>
        <label><span>一级部门</span><input name="firstDepartment" /></label>
        <label><span>二级部门</span><input name="secondDepartment" /></label>
        <label><span>职位</span><input name="position" /></label>
        <label><span>离职日期</span><input name="leftAt" type="date" /></label>
        <label><span>工作地点 *</span><select name="workLocation" defaultValue="" required><option value="" disabled>请选择</option><option value="UNSET">未设置</option><option value="SHANGHAI">上海</option><option value="SHENZHEN">深圳</option><option value="CHANGSHA">长沙</option><option value="XIAN">西安</option></select></label>
      </div>
      <p className="form-message" role="alert">{message}</p>
      <p className="field-help">初始密码统一为 DemoEmployeePass2026，首次登录必须修改。</p>
      <div className="form-actions"><Link href="/admin/employees">取消</Link><button className="primary-action" disabled={saving} type="submit">{saving ? "正在保存…" : "创建员工"}</button></div>
    </form>
  );
}

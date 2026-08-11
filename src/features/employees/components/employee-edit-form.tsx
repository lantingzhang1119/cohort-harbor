"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Employee = {
  id: string;
  employeeNo: string;
  name: string;
  email: string | null;
  firstDepartment: string | null;
  secondDepartment: string | null;
  position: string | null;
  workLocation: string;
  status: string;
  hiredAt: string | null;
  leftAt: string | null;
};

function dateInput(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function EmployeeEditFormForEmployee({ employeeId }: { employeeId: string }) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [message, setMessage] = useState("正在加载员工资料…");
  const [saving, setSaving] = useState(false);
  const [resettingEmployeeId, setResettingEmployeeId] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<{
    employeeId: string;
    value: string;
  } | null>(null);
  const resetPendingRef = useRef(false);
  const resetRequestVersion = useRef(0);

  useEffect(() => {
    resetRequestVersion.current += 1;
    resetPendingRef.current = false;
    const controller = new AbortController();
    fetch(`/api/admin/employees/${employeeId}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok: boolean; employee?: Employee; message?: string }) => {
        setEmployee(result.employee ?? null);
        setMessage(result.ok ? "" : result.message ?? "员工资料加载失败");
      })
      .catch(() => setMessage("员工资料加载失败"));
    return () => {
      resetRequestVersion.current += 1;
      resetPendingRef.current = false;
      controller.abort();
    };
  }, [employeeId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch(`/api/admin/employees/${employeeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, hiredAt: form.hiredAt || null, leftAt: form.leftAt || null }),
    });
    const result = await response.json() as { ok: boolean; message?: string };
    setMessage(result.ok ? "员工资料已保存" : result.message ?? "保存失败");
    setSaving(false);
  }

  async function resetPassword() {
    if (resetPendingRef.current) return;
    if (!window.confirm("确认为该员工生成一次性临时密码？现有登录会话将失效。")) return;
    resetPendingRef.current = true;
    const requestVersion = ++resetRequestVersion.current;
    setResettingEmployeeId(employeeId);
    setTemporaryPassword(null);
    try {
      const response = await fetch(`/api/admin/employees/${employeeId}/reset-password`, { method: "POST" });
      const result = await response.json() as {
        ok: boolean;
        temporaryPassword?: string;
        message?: string;
      };
      if (requestVersion !== resetRequestVersion.current) return;
      if (response.ok && result.ok && result.temporaryPassword) {
        setTemporaryPassword({ employeeId, value: result.temporaryPassword });
        setMessage("");
      } else {
        setMessage(result.message ?? "密码重置失败");
      }
    } catch {
      if (requestVersion === resetRequestVersion.current) {
        setMessage("密码重置失败");
      }
    } finally {
      if (requestVersion === resetRequestVersion.current) {
        resetPendingRef.current = false;
        setResettingEmployeeId(null);
      }
    }
  }

  if (!employee) return <p className="status-message">{message}</p>;
  return (
    <form className="employee-form" onSubmit={submit}>
      <div className="form-grid">
        <label><span>工号（不可修改）</span><input value={employee.employeeNo} disabled /></label>
        <label><span>姓名 *</span><input name="name" defaultValue={employee.name} required /></label>
        <label><span>邮箱 *</span><input name="email" type="email" defaultValue={employee.email ?? ""} required /></label>
        <label><span>入职日期 *</span><input name="hiredAt" type="date" defaultValue={dateInput(employee.hiredAt)} required /></label>
        <label><span>离职日期</span><input name="leftAt" type="date" defaultValue={dateInput(employee.leftAt)} /></label>
        <label><span>工作地点 *</span><select name="workLocation" defaultValue={employee.workLocation} required><option value="UNSET">未设置</option><option value="SHANGHAI">上海</option><option value="SHENZHEN">深圳</option><option value="CHANGSHA">长沙</option><option value="XIAN">西安</option></select></label>
        <label><span>一级部门</span><input name="firstDepartment" defaultValue={employee.firstDepartment ?? ""} /></label>
        <label><span>二级部门</span><input name="secondDepartment" defaultValue={employee.secondDepartment ?? ""} /></label>
        <label><span>职位</span><input name="position" defaultValue={employee.position ?? ""} /></label>
        <label><span>人员状态</span><select name="status" defaultValue={employee.status}><option value="ACTIVE">在职</option><option value="DEPARTED">离职</option><option value="DISABLED">停用</option><option value="REHIRE_PENDING">返聘待确认</option></select></label>
      </div>
      <p className="status-message" role="status">{message}</p>
      {temporaryPassword?.employeeId === employeeId && (
        <section className="bulk-bar" aria-label="一次性临时密码">
          <div>
            <strong>一次性临时密码</strong>
            <p><code>{temporaryPassword.value}</code></p>
            <p>请立即安全交付给员工，关闭后无法再次查看。</p>
          </div>
          <button type="button" onClick={() => setTemporaryPassword(null)}>
            我已记录，关闭
          </button>
        </section>
      )}
      <div className="form-actions split-actions"><button className="danger-action" disabled={resettingEmployeeId === employeeId} type="button" onClick={() => void resetPassword()}>重置密码</button><span /><Link href="/admin/employees">返回列表</Link><button className="primary-action" disabled={saving} type="submit">{saving ? "正在保存…" : "保存修改"}</button></div>
    </form>
  );
}

export function EmployeeEditForm({ employeeId }: { employeeId: string }) {
  return <EmployeeEditFormForEmployee key={employeeId} employeeId={employeeId} />;
}

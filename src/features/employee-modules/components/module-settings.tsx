"use client";

import { useState } from "react";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { EMPLOYEE_MODULE_DEFINITIONS } from "@/features/employee-modules/module-definitions";

export function ModuleSettings({
  initialEnabledKeys,
}: {
  initialEnabledKeys: readonly EmployeeModuleKey[];
}) {
  const [enabled, setEnabled] = useState(() => new Set(initialEnabledKeys));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  function toggle(key: EmployeeModuleKey) {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setMessage("");
    setIsError(false);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setMessage("");
    setIsError(false);
    try {
      const enabledKeys = EMPLOYEE_MODULE_DEFINITIONS
        .filter(({ key }) => enabled.has(key))
        .map(({ key }) => key);
      const response = await fetch("/api/admin/settings/employee-modules", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledKeys }),
      });
      const result = await response.json().catch(() => null) as {
        ok?: boolean;
        message?: string;
        enabledKeys?: EmployeeModuleKey[];
      } | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result?.message || "保存失败，请稍后重试");
      }
      setEnabled(new Set(result.enabledKeys ?? enabledKeys));
      setMessage("板块设置已保存");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error && error.message
        ? error.message
        : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="module-settings-card">
      <header>
        <div>
          <p className="eyebrow">EMPLOYEE VIEW · 全局权限</p>
          <h2>员工端板块</h2>
          <p>关闭后，员工端导航、首页入口、直接页面、接口和相关文件下载会同时停止开放。</p>
        </div>
        <span>{enabled.size}/{EMPLOYEE_MODULE_DEFINITIONS.length} 已开放</span>
      </header>
      <div className="module-settings-grid">
        {EMPLOYEE_MODULE_DEFINITIONS.map((definition) => (
          <label key={definition.key}>
            <input
              type="checkbox"
              checked={enabled.has(definition.key)}
              onChange={() => toggle(definition.key)}
              aria-label={`${definition.label}：${enabled.has(definition.key) ? "已开放" : "已关闭"}`}
            />
            <span>
              <strong>{definition.label}</strong>
              <small>{definition.description}</small>
            </span>
            <i>{enabled.has(definition.key) ? "开放" : "关闭"}</i>
          </label>
        ))}
      </div>
      <footer>
        <span className={isError ? "form-feedback error" : "form-feedback"} role={message ? (isError ? "alert" : "status") : undefined}>{message}</span>
        <button className="primary-action" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "正在保存…" : "保存板块设置"}
        </button>
      </footer>
    </section>
  );
}

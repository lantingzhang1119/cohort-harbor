"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { WorkLocation, type UserSource, type UserStatus } from "@/generated/prisma/enums";
import { useUrlFilters } from "@/lib/ui/use-url-filters";

type Employee = {
  id: string;
  employeeNo: string;
  name: string;
  email: string | null;
  firstDepartment: string | null;
  secondDepartment: string | null;
  position: string | null;
  workLocation: WorkLocation;
  status: UserStatus;
  enabled: boolean;
  sourceType: UserSource;
};

const locationLabels: Record<WorkLocation, string> = {
  SHANGHAI: "上海",
  SHENZHEN: "深圳",
  CHANGSHA: "长沙",
  XIAN: "西安",
  UNSET: "未设置",
};

type EmployeeFilters = {
  query: string;
  location: string;
  enabled: string;
  source: string;
  page: string;
  pageSize: string;
};

const employeeFilterKeys = ["query", "location", "enabled", "source", "page", "pageSize"] as const;
const workLocations = new Set<string>(Object.values(WorkLocation));
const userSources = new Set<string>(["MANUAL", "EXCEL"]);
const employeePageSizes = new Set(["10", "20", "50", "100"]);

function positiveInteger(value: string | null, fallback: string) {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) return fallback;
  return String(Math.floor(Number(value)));
}

function readEmployeeFilters(params: URLSearchParams): EmployeeFilters {
  const location = params.get("location") ?? "";
  const enabled = params.get("enabled") ?? "";
  return {
    query: params.get("query") ?? "",
    location: workLocations.has(location) ? location : "",
    enabled: enabled === "true" || enabled === "false" ? enabled : "",
    source: userSources.has(params.get("source") ?? "") ? (params.get("source") ?? "") : "",
    page: positiveInteger(params.get("page"), "1"),
    pageSize: employeePageSizes.has(params.get("pageSize") ?? "")
      ? (params.get("pageSize") ?? "20")
      : "20",
  };
}

function normalizeEmployeeFilters(initial?: Partial<EmployeeFilters>): EmployeeFilters {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(initial ?? {})) {
    if (value) params.set(key, value);
  }
  return readEmployeeFilters(params);
}

function employeeFilterParams(filters: EmployeeFilters) {
  const params = new URLSearchParams();
  if (filters.query) params.set("query", filters.query);
  if (filters.location) params.set("location", filters.location);
  if (filters.enabled) params.set("enabled", filters.enabled);
  if (filters.source) params.set("source", filters.source);
  params.set("page", filters.page);
  params.set("pageSize", filters.pageSize);
  return params;
}

type EmployeeListResponse = {
  ok: boolean;
  items?: Employee[];
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  message?: string;
};

export function EmployeeAdmin({
  initialFilters,
}: {
  initialFilters?: Partial<EmployeeFilters>;
} = {}) {
  const [items, setItems] = useState<Employee[]>([]);
  const [filters, updateFilters] = useUrlFilters(
    normalizeEmployeeFilters(initialFilters),
    employeeFilterKeys,
    readEmployeeFilters,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("正在加载员工…");
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [resettingEmployeeId, setResettingEmployeeId] = useState<string | null>(null);
  const resetPendingRef = useRef(false);
  const resetRequestVersion = useRef(0);
  const [temporaryPassword, setTemporaryPassword] = useState<{
    employeeName: string;
    value: string;
  } | null>(null);

  const applyListResult = useCallback((result: EmployeeListResponse) => {
    if (result.ok) {
      const nextItems = result.items ?? [];
      const page = result.page ?? Number(filters.page);
      const pageSize = result.pageSize ?? Number(filters.pageSize);
      const total = result.total ?? nextItems.length;
      const totalPages = result.totalPages ?? (total === 0 ? 0 : Math.ceil(total / pageSize));
      if (nextItems.length === 0 && totalPages > 0 && page > totalPages) {
        updateFilters({ page: String(totalPages) });
        return;
      }
      setItems(nextItems);
      setPagination({ page, pageSize, total, totalPages });
      setMessage(nextItems.length ? "" : "暂无符合条件的员工");
    } else setMessage(result.message ?? "员工列表加载失败");
  }, [filters.page, filters.pageSize, updateFilters]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = employeeFilterParams(filters);
    const response = await fetch(`/api/admin/employees?${params}`, signal ? { signal } : undefined);
    applyListResult((await response.json()) as EmployeeListResponse);
  }, [applyListResult, filters]);

  useEffect(() => {
    const controller = new AbortController();
    const params = employeeFilterParams(filters);
    fetch(`/api/admin/employees?${params}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<EmployeeListResponse>)
      .then(applyListResult)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("员工列表加载失败");
        }
    });
    return () => controller.abort();
  }, [applyListResult, filters]);

  function changeFilters(patch: Partial<EmployeeFilters>) {
    setSelected([]);
    setMessage("正在加载员工…");
    updateFilters(patch);
  }

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function setBulkLocation(nextLocation: WorkLocation) {
    if (!selected.length) return;
    const response = await fetch("/api/admin/employees/bulk-location", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeIds: selected, location: nextLocation }),
    });
    const result = (await response.json()) as { ok: boolean; message?: string };
    if (result.ok) {
      const updatedCount = selected.length;
      setSelected([]);
      await load();
      setMessage(`已更新 ${updatedCount} 名员工的工作地点`);
    } else setMessage(result.message ?? "更新失败");
  }

  async function toggleEnabled(employee: Employee) {
    const response = await fetch(`/api/admin/employees/${employee.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !employee.enabled }),
    });
    if (response.ok) await load();
    else setMessage("账号状态更新失败");
  }

  async function resetPassword(employee: Employee) {
    if (resetPendingRef.current) return;
    resetPendingRef.current = true;
    const requestVersion = ++resetRequestVersion.current;
    setResettingEmployeeId(employee.id);
    setTemporaryPassword(null);
    try {
      const response = await fetch(`/api/admin/employees/${employee.id}/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await response.json()) as {
        ok: boolean;
        temporaryPassword?: string;
        message?: string;
      };
      if (requestVersion !== resetRequestVersion.current) return;
      if (result.ok && result.temporaryPassword) {
        setTemporaryPassword({ employeeName: employee.name, value: result.temporaryPassword });
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

  return (
    <main className="admin-content employee-page">
      <header className="page-title-row">
        <div>
          <p className="eyebrow">PEOPLE · 员工账号</p>
          <h1>员工管理</h1>
          <p>维护本地 Demo 账号、工作地点与登录状态。</p>
        </div>
        <Link className="primary-action" href="/admin/employees/new">新增员工</Link>
      </header>

      <section className="filter-panel" aria-label="员工筛选">
        <label>
          <span>搜索</span>
          <input value={filters.query} onChange={(event) => changeFilters({ query: event.target.value, page: "1" })} placeholder="姓名或工号" />
        </label>
        <label>
          <span>工作地点</span>
          <select value={filters.location} onChange={(event) => changeFilters({ location: event.target.value, page: "1" })}>
            <option value="">全部地点</option>
            {Object.entries(locationLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>账号状态</span>
          <select value={filters.enabled} onChange={(event) => changeFilters({ enabled: event.target.value, page: "1" })}>
            <option value="">全部状态</option>
            <option value="true">仅看启用</option>
            <option value="false">仅看停用</option>
          </select>
        </label>
        <label>
          <span>账号来源</span>
          <select value={filters.source} onChange={(event) => changeFilters({ source: event.target.value, page: "1" })}>
            <option value="">全部来源</option>
            <option value="MANUAL">手工创建</option>
            <option value="EXCEL">Excel 导入</option>
          </select>
        </label>
        <button type="button" onClick={() => changeFilters({ location: "UNSET", page: "1" })}>仅看地点未设置</button>
      </section>

      {selected.length > 0 && (
        <section className="bulk-bar" aria-label="批量操作">
          <strong>已选择 {selected.length} 人</strong>
          <select defaultValue="" onChange={(event) => void setBulkLocation(event.target.value as WorkLocation)}>
            <option value="" disabled>批量设置工作地点</option>
            {Object.entries(locationLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button type="button" onClick={() => setSelected([])}>取消选择</button>
        </section>
      )}

      <p className="status-message" aria-live="polite">{message}</p>
      {temporaryPassword && (
        <section className="bulk-bar" aria-label="一次性临时密码">
          <div>
            <strong>一次性临时密码</strong>
            <p>
              {temporaryPassword.employeeName}：<code>{temporaryPassword.value}</code>
            </p>
            <p>请立即安全交付给员工，关闭后无法再次查看。</p>
          </div>
          <button type="button" onClick={() => setTemporaryPassword(null)}>
            我已记录，关闭
          </button>
        </section>
      )}
      <section className="employee-table-wrap">
        <table className="employee-table">
          <thead><tr><th>选择</th><th>员工</th><th>部门 / 职位</th><th>地点</th><th>来源</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {items.map((employee) => (
              <tr key={employee.id}>
                <td><input aria-label={`选择 ${employee.name}`} type="checkbox" checked={selected.includes(employee.id)} onChange={() => toggle(employee.id)} /></td>
                <td><strong>{employee.name}</strong><span>{employee.employeeNo}</span><span>{employee.email ?? "未提供邮箱"}</span></td>
                <td>{employee.firstDepartment ?? "未设置部门"}<span>{employee.position ?? "未设置职位"}</span></td>
                <td><span className={employee.workLocation === "UNSET" ? "tag warning" : "tag"}>{locationLabels[employee.workLocation]}</span></td>
                <td>{employee.sourceType === "MANUAL" ? "手工" : "Excel"}</td>
                <td><span className={employee.enabled ? "tag success" : "tag muted"}>{employee.enabled ? "可登录" : "已停用"}</span></td>
                <td><div className="row-actions"><Link href={`/admin/employees/${employee.id}/edit`}>编辑</Link><button type="button" disabled={resettingEmployeeId !== null} onClick={() => void resetPassword(employee)}>重置密码</button><button type="button" onClick={() => void toggleEnabled(employee)}>{employee.enabled ? "停用" : "启用"}</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="employee-cards">
          {items.map((employee) => (
            <article className="employee-card" key={employee.id}>
              <header><input aria-label={`选择 ${employee.name}`} type="checkbox" checked={selected.includes(employee.id)} onChange={() => toggle(employee.id)} /><div><strong>{employee.name}</strong><span>{employee.employeeNo}</span></div><span className={employee.enabled ? "tag success" : "tag muted"}>{employee.enabled ? "可登录" : "已停用"}</span></header>
              <dl><div><dt>部门 / 职位</dt><dd>{employee.firstDepartment ?? "未设置"} · {employee.position ?? "未设置"}</dd></div><div><dt>工作地点</dt><dd>{locationLabels[employee.workLocation]}</dd></div><div><dt>邮箱</dt><dd>{employee.email ?? "未提供"}</dd></div></dl>
              <div className="card-actions"><Link href={`/admin/employees/${employee.id}/edit`}>编辑资料</Link><button type="button" disabled={resettingEmployeeId !== null} onClick={() => void resetPassword(employee)}>重置密码</button><button type="button" onClick={() => void toggleEnabled(employee)}>{employee.enabled ? "停用账号" : "重新启用"}</button></div>
            </article>
          ))}
        </div>
      </section>
      {pagination.total > 0 && (
        <nav className="employee-pagination" aria-label="员工分页">
          <p>共 {pagination.total} 名员工 · 第 {pagination.page} / {pagination.totalPages} 页</p>
          <label>
            <span>每页显示</span>
            <select
              aria-label="每页显示"
              value={filters.pageSize}
              onChange={(event) => changeFilters({ pageSize: event.target.value, page: "1" })}
            >
              {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size} 条</option>)}
            </select>
          </label>
          <div>
            <button type="button" disabled={pagination.page <= 1} onClick={() => changeFilters({ page: "1" })}>首页</button>
            <button type="button" disabled={pagination.page <= 1} onClick={() => changeFilters({ page: String(pagination.page - 1) })}>上一页</button>
            <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => changeFilters({ page: String(pagination.page + 1) })}>下一页</button>
            <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => changeFilters({ page: String(pagination.totalPages) })}>末页</button>
          </div>
        </nav>
      )}
    </main>
  );
}

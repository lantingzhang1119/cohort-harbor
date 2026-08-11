import type {
  EmployeeRow,
  AssigneePreview,
} from "@/features/exam-tasks/components/publish-wizard-types";
import { locationLabels } from "@/features/exam-tasks/components/publish-wizard-types";
import {
  isSelected,
  type WizardEmployeeFilter,
  type WizardSelectionState,
} from "@/features/exam-tasks/selection-state";

export function EmployeeSelectionStep({
  employees,
  filter,
  selection,
  preview,
  total,
  totalPages,
  page,
  pageSize,
  allOnPageSelected,
  onFilterChange,
  onToggle,
  onSelectPage,
  onClearPage,
  onSelectAll,
  onClearAll,
  onPageChange,
  onPageSizeChange,
}: {
  employees: EmployeeRow[];
  filter: WizardEmployeeFilter;
  selection: WizardSelectionState;
  preview: { total: number; employees: AssigneePreview[] } | null;
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  allOnPageSelected: boolean;
  onFilterChange: (patch: Partial<WizardEmployeeFilter>) => void;
  onToggle: (employeeId: string) => void;
  onSelectPage: () => void;
  onClearPage: () => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <section className="exam-task-step-card" aria-label="选择员工">
      <header>
        <h2>2. 选择员工</h2>
        <p>支持姓名/工号搜索、城市与部门筛选、全选当前页、跨页保持，以及全选全部筛选结果。</p>
      </header>

      <div className="filter-panel exam-task-filter-panel" aria-label="员工筛选">
        <label>
          <span>搜索</span>
          <input
            value={filter.query}
            onChange={(event) => onFilterChange({ query: event.target.value })}
            placeholder="姓名或工号"
          />
        </label>
        <label>
          <span>部门</span>
          <input
            value={filter.department}
            onChange={(event) => onFilterChange({ department: event.target.value })}
            placeholder="一级部门"
          />
        </label>
        <label>
          <span>城市</span>
          <select
            value={filter.location}
            onChange={(event) => onFilterChange({ location: event.target.value })}
          >
            <option value="">全部地点</option>
            {Object.entries(locationLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>账号状态</span>
          <select
            value={filter.enabled}
            onChange={(event) => onFilterChange({ enabled: event.target.value })}
          >
            <option value="">全部状态</option>
            <option value="true">仅看启用</option>
            <option value="false">仅看停用</option>
          </select>
        </label>
      </div>

      <div className="bulk-bar exam-task-selection-bar" aria-label="批量选择">
        <strong>
          已选择 {selection.mode === "EXPLICIT"
            ? selection.selectedIds.length
            : preview?.total ?? `筛选结果 − ${selection.excludedIds.length}`} 人
          {selection.mode === "FILTER" ? "（筛选全选模式）" : ""}
        </strong>
        <button type="button" onClick={onSelectPage}>全选当前页</button>
        <button type="button" onClick={onClearPage}>取消当前页</button>
        <button type="button" onClick={onSelectAll}>全选全部筛选结果</button>
        <button type="button" onClick={onClearAll}>清空选择</button>
        {allOnPageSelected ? <span className="tag success">当前页已全选</span> : null}
      </div>

      <section className="employee-table-wrap">
        <table className="employee-table">
          <thead>
            <tr><th>选择</th><th>员工</th><th>部门</th><th>地点</th><th>状态</th></tr>
          </thead>
          <tbody>
            {employees.map((employee) => {
              const eligible = employee.enabled && employee.status === "ACTIVE";
              return (
                <tr key={employee.id}>
                  <td>
                    <input
                      aria-label={`选择 ${employee.name}`}
                      type="checkbox"
                      checked={isSelected(selection, employee.id)}
                      disabled={!eligible}
                      onChange={() => onToggle(employee.id)}
                    />
                  </td>
                  <td><strong>{employee.name}</strong><span>{employee.employeeNo}</span></td>
                  <td>{employee.firstDepartment ?? "未设置部门"}</td>
                  <td><span className="tag">{locationLabels[employee.workLocation]}</span></td>
                  <td>
                    <span className={eligible ? "tag success" : "tag muted"}>
                      {eligible ? "可分配" : employee.enabled ? "非在职" : "已停用"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="employee-cards">
          {employees.map((employee) => {
            const eligible = employee.enabled && employee.status === "ACTIVE";
            return (
              <article className="employee-card" key={employee.id}>
                <header>
                  <input
                    aria-label={`选择 ${employee.name}（卡片）`}
                    type="checkbox"
                    checked={isSelected(selection, employee.id)}
                    disabled={!eligible}
                    onChange={() => onToggle(employee.id)}
                  />
                  <div><strong>{employee.name}</strong><span>{employee.employeeNo}</span></div>
                </header>
                <dl>
                  <div><dt>部门</dt><dd>{employee.firstDepartment ?? "未设置"}</dd></div>
                  <div><dt>地点</dt><dd>{locationLabels[employee.workLocation]}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      {total > 0 ? (
        <nav className="employee-pagination" aria-label="员工分页">
          <p>共 {total} 名 · 第 {page} / {Math.max(totalPages, 1)} 页</p>
          <label>
            <span>每页显示</span>
            <select
              aria-label="每页显示"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>{size} 条</option>
              ))}
            </select>
          </label>
          <div>
            <button type="button" disabled={page <= 1} onClick={() => onPageChange(1)}>首页</button>
            <button type="button" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>上一页</button>
            <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
            <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>末页</button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

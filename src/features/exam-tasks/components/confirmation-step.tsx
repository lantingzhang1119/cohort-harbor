import {
  formatShanghaiDisplay,
  shanghaiDatetimeLocalToDate,
} from "@/features/exam-tasks/datetime-shanghai";
import type {
  AssigneePreview,
  SelectableBank,
} from "@/features/exam-tasks/components/publish-wizard-types";

export function ConfirmationStep({
  bank,
  questionBankId,
  name,
  description,
  startsAtLocal,
  endsAtLocal,
  passingScore,
  preview,
  published,
  onRemove,
}: {
  bank: SelectableBank | null;
  questionBankId: string;
  name: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  passingScore: number;
  preview: { total: number; employees: AssigneePreview[] } | null;
  published: boolean;
  onRemove: (employeeId: string) => void;
}) {
  return (
    <section className="exam-task-step-card" aria-label="确认发布">
      <header>
        <h2>4. 确认发布</h2>
        <p>发布将在单事务内创建试卷快照、任务、全部分配与站内通知；失败全部回滚。</p>
      </header>
      <dl className="exam-task-confirm-summary">
        <div>
          <dt>题库</dt>
          <dd>
            {bank
              ? `${bank.name} · v${bank.versionNumber} · ${bank.questionCount} 题 · 总分 ${bank.enabledScore}`
              : questionBankId}
          </dd>
        </div>
        <div><dt>考试名称</dt><dd>{name || "—"}</dd></div>
        <div><dt>说明</dt><dd>{description.trim() || "无"}</dd></div>
        <div>
          <dt>时间窗口（上海）</dt>
          <dd>
            {formatShanghaiDisplay(shanghaiDatetimeLocalToDate(startsAtLocal))}
            {" — "}
            {formatShanghaiDisplay(shanghaiDatetimeLocalToDate(endsAtLocal))}
          </dd>
        </div>
        <div><dt>及格分</dt><dd>{passingScore}</dd></div>
        <div><dt>补考规则</dt><dd>默认一次补考；仍未通过需申请管理员审批。</dd></div>
        <div><dt>选中员工</dt><dd>{preview?.total ?? 0} 人</dd></div>
      </dl>

      <div className="exam-task-selected-list" aria-label="已选名单">
        <h3>已选名单</h3>
        {(preview?.employees ?? []).length === 0 ? (
          <p className="hint-text">暂无名单</p>
        ) : (
          <ul>
            {(preview?.employees ?? []).map((employee) => (
              <li key={employee.id}>
                <span>
                  <strong>{employee.name}</strong> {employee.employeeNo}
                  {employee.firstDepartment ? ` · ${employee.firstDepartment}` : ""}
                </span>
                {!published ? (
                  <button type="button" onClick={() => onRemove(employee.id)}>移除</button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {preview && preview.total > preview.employees.length ? (
          <p className="hint-text">
            名单预览显示前 {preview.employees.length} 人，实际将分配 {preview.total} 人。
          </p>
        ) : null}
      </div>
    </section>
  );
}

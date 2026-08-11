"use client";

import { useEffect, useMemo, useState } from "react";

import { BankSelectionStep } from "@/features/exam-tasks/components/bank-selection-step";
import { ConfirmationStep } from "@/features/exam-tasks/components/confirmation-step";
import { EmployeeSelectionStep } from "@/features/exam-tasks/components/employee-selection-step";
import type {
  AssigneePreview,
  EmployeeRow,
  SelectableBank,
} from "@/features/exam-tasks/components/publish-wizard-types";
import { ScheduleStep } from "@/features/exam-tasks/components/schedule-step";
import {
  shanghaiDatetimeLocalToDate,
  toShanghaiDatetimeLocalValue,
} from "@/features/exam-tasks/datetime-shanghai";
import {
  clearCurrentPage,
  emptyExplicitSelection,
  emptyWizardFilter,
  pageSelectionSummary,
  removeSelectedUser,
  selectAllFiltered,
  selectCurrentPage,
  toApiSelection,
  toggleUser,
  type WizardEmployeeFilter,
  type WizardSelectionState,
} from "@/features/exam-tasks/selection-state";

const STEPS = ["选择题库", "选择员工", "时间与规则", "确认发布"] as const;

function defaultScheduleValues() {
  return {
    startsAtLocal: toShanghaiDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000)),
    endsAtLocal: toShanghaiDatetimeLocalValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  };
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `exam-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PublishExamTaskWizard() {
  const [step, setStep] = useState(0);
  const [banks, setBanks] = useState<SelectableBank[]>([]);
  const [defaultBankId, setDefaultBankId] = useState<string | null>(null);
  const [questionBankId, setQuestionBankId] = useState("");
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [filter, setFilter] = useState<WizardEmployeeFilter>(emptyWizardFilter);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [selection, setSelection] = useState<WizardSelectionState>(emptyExplicitSelection());
  const [preview, setPreview] = useState<{ total: number; employees: AssigneePreview[] } | null>(null);
  const scheduleDefaults = useMemo(() => defaultScheduleValues(), []);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAtLocal, setStartsAtLocal] = useState(scheduleDefaults.startsAtLocal);
  const [endsAtLocal, setEndsAtLocal] = useState(scheduleDefaults.endsAtLocal);
  const [passingScore, setPassingScore] = useState(80);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [message, setMessage] = useState("正在加载…");
  const [busy, setBusy] = useState(false);
  const [publishedTaskId, setPublishedTaskId] = useState<string | null>(null);

  const selectedBank = banks.find((bank) => bank.id === questionBankId) ?? null;
  const pageIds = employees
    .filter((employee) => employee.enabled && employee.status === "ACTIVE")
    .map((employee) => employee.id);
  const pageSummary = pageSelectionSummary(selection, pageIds);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/exam-tasks/selectable-banks", { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          ok: boolean;
          banks?: SelectableBank[];
          defaultBankId?: string | null;
          message?: string;
        };
        if (!response.ok || !result.ok) {
          setMessage(result.message ?? "可选题库加载失败");
          return;
        }
        const nextBanks = result.banks ?? [];
        const nextDefault = result.defaultBankId ?? null;
        setBanks(nextBanks);
        setDefaultBankId(nextDefault);
        setQuestionBankId((current) =>
          current && nextBanks.some((bank) => bank.id === current)
            ? current
            : nextDefault ?? nextBanks[0]?.id ?? "",
        );
        setMessage(nextBanks.length ? "" : "暂无已启用、满 100 分且校验通过的题库");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("可选题库加载失败");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filter.query) params.set("query", filter.query);
    if (filter.department) params.set("department", filter.department);
    if (filter.location) params.set("location", filter.location);
    if (filter.enabled) params.set("enabled", filter.enabled);
    fetch(`/api/admin/employees?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          ok: boolean;
          items?: EmployeeRow[];
          total?: number;
          totalPages?: number;
          message?: string;
        };
        if (!response.ok || !result.ok) {
          setMessage(result.message ?? "员工列表加载失败");
          return;
        }
        setEmployees(result.items ?? []);
        setTotal(result.total ?? 0);
        setTotalPages(result.totalPages ?? 0);
        setMessage("");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage("员工列表加载失败");
        }
      });
    return () => controller.abort();
  }, [filter, page, pageSize, step]);

  async function refreshPreview(nextSelection: WizardSelectionState = selection) {
    const apiSelection = toApiSelection(nextSelection);
    if (!apiSelection) {
      setPreview({ total: 0, employees: [] });
      return 0;
    }
    try {
      const response = await fetch("/api/admin/exam-tasks/resolve-assignees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: apiSelection }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        total?: number;
        employees?: AssigneePreview[];
        message?: string;
      };
      if (!response.ok || !result.ok) {
        setMessage(result.message ?? "无法解析选中员工");
        setPreview(null);
        return null;
      }
      setPreview({ total: result.total ?? 0, employees: result.employees ?? [] });
      setMessage("");
      return result.total ?? 0;
    } catch {
      setMessage("无法解析选中员工，请检查网络后重试");
      setPreview(null);
      return null;
    }
  }

  async function goNext() {
    if (step === 0) {
      if (!questionBankId) return setMessage("请选择一套校验通过的 100 分题库");
      setStep(1);
      setMessage("");
      return;
    }
    if (step === 1) {
      const count = await refreshPreview();
      if (!count) return setMessage("请至少选择一名可分配员工");
      setStep(2);
      return;
    }
    if (!name.trim()) return setMessage("请填写考试名称");
    const startsAt = shanghaiDatetimeLocalToDate(startsAtLocal);
    const endsAt = shanghaiDatetimeLocalToDate(endsAtLocal);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return setMessage("开始或结束时间无效");
    }
    if (startsAt >= endsAt) return setMessage("开始时间必须早于结束时间");
    if (!Number.isInteger(passingScore) || passingScore < 1 || passingScore > 100) {
      return setMessage("及格分须为 1–100 的整数");
    }
    const count = await refreshPreview();
    if (!count) return setMessage("请至少选择一名可分配员工");
    setStep(3);
    setMessage("");
  }

  async function publish() {
    if (busy || publishedTaskId) return;
    const apiSelection = toApiSelection(selection);
    if (!apiSelection) return setMessage("请至少选择一名员工");
    setBusy(true);
    setMessage("正在发布…");
    try {
      const response = await fetch("/api/admin/exam-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          name: name.trim(),
          description: description.trim() || null,
          questionBankId,
          startsAt: shanghaiDatetimeLocalToDate(startsAtLocal).toISOString(),
          endsAt: shanghaiDatetimeLocalToDate(endsAtLocal).toISOString(),
          passingScore,
          selection: apiSelection,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        task?: { id: string; replayed: boolean; assignmentCount: number };
        message?: string;
      };
      if (!response.ok || !result.ok || !result.task) {
        setMessage(result.message ?? "发布失败");
        return;
      }
      setPublishedTaskId(result.task.id);
      setMessage(result.task.replayed
        ? `已返回相同幂等键的原任务（${result.task.assignmentCount} 人），未重复创建`
        : `发布成功，已分配 ${result.task.assignmentCount} 名员工`);
    } catch {
      setMessage("发布请求未完成，请重试；幂等键会阻止重复创建");
    } finally {
      setBusy(false);
    }
  }

  function changeFilter(patch: Partial<WizardEmployeeFilter>) {
    const nextFilter = { ...filter, ...patch };
    setFilter(nextFilter);
    setPage(1);
    if (selection.mode === "FILTER") {
      setSelection((current) => current.mode === "FILTER"
        ? { ...current, filter: nextFilter }
        : current);
      setPreview(null);
    }
  }

  function removeEmployee(employeeId: string) {
    setSelection((current) => removeSelectedUser(current, employeeId));
    setPreview((current) => current ? {
      total: Math.max(0, current.total - 1),
      employees: current.employees.filter((employee) => employee.id !== employeeId),
    } : current);
  }

  return (
    <main className="admin-content exam-task-publish-page">
      <header className="page-title-row">
        <div>
          <p className="eyebrow">EXAM · 考试任务</p>
          <h1>发布考试任务</h1>
          <p>选择题库、批量选人、设定上海时区时间窗口，一次事务发布不可变试卷快照。</p>
        </div>
      </header>

      <nav className="exam-task-wizard-steps" aria-label="发布步骤">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            className={index === step ? "active" : index < step ? "done" : ""}
            onClick={() => { if (index < step && !publishedTaskId) setStep(index); }}
            disabled={Boolean(publishedTaskId) || index > step}
          >
            <span>{index + 1}</span>{label}
          </button>
        ))}
      </nav>

      {message ? <p className="status-message" aria-live="polite">{message}</p> : null}

      {step === 0 ? (
        <BankSelectionStep
          banks={banks}
          defaultBankId={defaultBankId}
          questionBankId={questionBankId}
          onSelect={setQuestionBankId}
        />
      ) : null}
      {step === 1 ? (
        <EmployeeSelectionStep
          employees={employees}
          filter={filter}
          selection={selection}
          preview={preview}
          total={total}
          totalPages={totalPages}
          page={page}
          pageSize={pageSize}
          allOnPageSelected={pageSummary.allOnPageSelected}
          onFilterChange={changeFilter}
          onToggle={(employeeId) => setSelection((current) => toggleUser(current, employeeId, pageIds))}
          onSelectPage={() => setSelection((current) => selectCurrentPage(current, pageIds))}
          onClearPage={() => setSelection((current) => clearCurrentPage(current, pageIds))}
          onSelectAll={() => {
            const next = selectAllFiltered(filter);
            setSelection(next);
            void refreshPreview(next);
          }}
          onClearAll={() => { setSelection(emptyExplicitSelection()); setPreview(null); }}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      ) : null}
      {step === 2 ? (
        <ScheduleStep
          name={name}
          description={description}
          startsAtLocal={startsAtLocal}
          endsAtLocal={endsAtLocal}
          passingScore={passingScore}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onStartsAtChange={setStartsAtLocal}
          onEndsAtChange={setEndsAtLocal}
          onPassingScoreChange={setPassingScore}
        />
      ) : null}
      {step === 3 ? (
        <ConfirmationStep
          bank={selectedBank}
          questionBankId={questionBankId}
          name={name}
          description={description}
          startsAtLocal={startsAtLocal}
          endsAtLocal={endsAtLocal}
          passingScore={passingScore}
          preview={preview}
          published={Boolean(publishedTaskId)}
          onRemove={removeEmployee}
        />
      ) : null}

      <footer className="exam-task-wizard-footer">
        <button
          type="button"
          disabled={step === 0 || busy || Boolean(publishedTaskId)}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >上一步</button>
        {step < 3 ? (
          <button className="primary-action" type="button" disabled={busy} onClick={() => void goNext()}>
            下一步
          </button>
        ) : (
          <button
            className="primary-action"
            type="button"
            disabled={busy || Boolean(publishedTaskId) || !preview?.total}
            onClick={() => void publish()}
          >
            {busy ? "发布中…" : publishedTaskId ? "已发布" : "确认发布"}
          </button>
        )}
      </footer>
    </main>
  );
}

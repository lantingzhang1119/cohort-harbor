"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CommonFieldManager, type MailField } from "@/features/onboarding-mail/components/common-field-manager";
import { DeliveryHistory, type Delivery } from "@/features/onboarding-mail/components/delivery-history";
import { TemplateEditor, type AssetLibrary, type MailEmployee, type MailRevision, type MailTemplate } from "@/features/onboarding-mail/components/template-editor";

type Tab = "TEMPLATE" | "FIELDS" | "TODAY" | "HISTORY";
const tabs: Array<{ id: Tab; label: string }> = [{ id: "TEMPLATE", label: "邮件模板" }, { id: "FIELDS", label: "常用字段" }, { id: "TODAY", label: "今日待发送" }, { id: "HISTORY", label: "发送记录" }];

type DiagnosticEmployee = MailEmployee & { eligible: boolean; reason?: string; reasonLabel?: string };
type MissedEmployee = MailEmployee & { localDate: string; reasonLabel: string };
type MailCenterData = {
  overview: {
    smtp: { configured: boolean; lastSuccessfulTestAt?: string | null };
    automation: { enabled: boolean; confirmRecipientCount?: number };
    today: { localDate: string; matched: number; eligible: number; excluded: number; employees: DiagnosticEmployee[] };
    pastMissed: MissedEmployee[];
    truncation?: { pastMissed: { limit: number; truncated: boolean } };
    confirmations: { enqueueToday: { token: string }; enableAutomation: { token: string } };
  };
  template: MailTemplate | null;
  fields: MailField[];
  assets: AssetLibrary;
  deliveries: Delivery[];
  revisions: MailRevision[];
  deliveriesTruncated: boolean;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? "加载失败");
  return payload;
}

export function MailCenter() {
  const [tab, setTab] = useState<Tab>("TEMPLATE");
  const [data, setData] = useState<MailCenterData | null>(null);
  const [error, setError] = useState("");
  const [todayMessage, setTodayMessage] = useState("");
  const [selectedMissed, setSelectedMissed] = useState<string[]>([]);
  const [initializingTemplate, setInitializingTemplate] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson<MailCenterData["overview"]>("/api/admin/onboarding-mail/overview"),
      getJson<{ template: MailTemplate | null }>("/api/admin/onboarding-mail/templates"),
      getJson<{ fields: MailField[] }>("/api/admin/onboarding-mail/fields"),
      getJson<AssetLibrary>("/api/admin/onboarding-mail/assets"),
      getJson<{ deliveries: Delivery[]; truncation?: { deliveries: { limit: number; truncated: boolean } } }>("/api/admin/onboarding-mail/deliveries"),
    ]).then(async ([overview, templates, fields, assets, deliveries]) => {
      const revisions = templates.template ? await getJson<{ revisions: MailRevision[] }>(`/api/admin/onboarding-mail/revisions?templateId=${encodeURIComponent(templates.template.id)}`) : { revisions: [] };
      if (active) setData({
        overview, template: templates.template, fields: fields.fields ?? [], assets,
        deliveries: deliveries.deliveries ?? [],
        deliveriesTruncated: deliveries.truncation?.deliveries.truncated ?? false,
        revisions: revisions.revisions ?? [],
      });
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); });
    return () => { active = false; };
  }, []);

  const employees = useMemo(() => data?.overview.today.employees ?? [], [data]);
  if (error) return <main className="mail-center"><p role="alert">{error}</p></main>;
  if (!data) return <main className="mail-center" aria-busy="true"><p>正在加载邮件中心…</p></main>;
  const loadedData = data;

  async function mutate<T extends { message?: string }>(url: string, body: unknown, success: (payload: T) => string) {
    setPendingAction(url);
    try {
      const response = await fetch(url, { method: url.endsWith("/automation") ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as T;
      setTodayMessage(response.ok ? success(payload) : payload.message ?? "操作失败");
      return { response, payload };
    } finally {
      setPendingAction(null);
    }
  }

  async function runToday() {
    const count = loadedData.overview.today.eligible;
    if (!window.confirm(`页面显示今日可发送 ${count} 人。确认创建邮件？`)) return;
    const result = await mutate<{ message?: string; summary: { enqueued: number } }>("/api/admin/onboarding-mail/enqueue-today", { localDate: loadedData.overview.today.localDate, confirmed: true, displayedRecipientCount: count, confirmationToken: loadedData.overview.confirmations.enqueueToday.token }, (payload) => `已创建 ${payload.summary.enqueued} 封今日邮件`);
    if (result.response.ok) setData((current) => current ? { ...current, overview: { ...current.overview, today: {
      ...current.overview.today,
      eligible: Math.max(0, current.overview.today.eligible - result.payload.summary.enqueued),
      excluded: Math.min(current.overview.today.matched, current.overview.today.excluded + result.payload.summary.enqueued),
      employees: current.overview.today.employees.map((employee) => employee.eligible
        ? { ...employee, eligible: false, reason: "ALREADY_QUEUED", reasonLabel: "已创建待发送邮件" }
        : employee),
    } } } : current);
  }

  async function manualMissed() {
    if (!selectedMissed.length) { setTodayMessage("请先选择历史漏发员工"); return; }
    const rows = loadedData.overview.pastMissed.filter((item) => selectedMissed.includes(item.id));
    const localDate = rows[0]?.localDate;
    if (!localDate || rows.some((item) => item.localDate !== localDate)) { setTodayMessage("请一次只选择同一入职日期的员工"); return; }
    if (!window.confirm(`确认手动发送所选 ${rows.length} 人？`)) return;
    setPendingAction("manual-confirmation");
    try {
      const confirmationResponse = await fetch("/api/admin/onboarding-mail/confirmations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "MANUAL_SEND", localDate, selectedIds: selectedMissed }),
      });
      const confirmation = await confirmationResponse.json() as { confirmationToken?: string; message?: string };
      if (!confirmationResponse.ok || !confirmation.confirmationToken) {
        setTodayMessage(confirmation.message ?? "无法确认手动发送选择");
        return;
      }
      const result = await mutate<{ message?: string; created: number }>("/api/admin/onboarding-mail/manual-send", {
        employeeIds: selectedMissed,
        localDate,
        displayedRecipientCount: rows.length,
        confirmed: true,
        confirmationToken: confirmation.confirmationToken,
      }, (payload) => `已创建 ${payload.created} 封手动邮件`);
      if (result.response.ok) {
        const sentIds = new Set(selectedMissed);
        setData((current) => current ? { ...current, overview: { ...current.overview, pastMissed: current.overview.pastMissed.filter((item) => !sentIds.has(item.id)) } } : current);
        setSelectedMissed([]);
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function smtpTest() {
    const result = await mutate<{ message?: string; testedAt: string }>("/api/admin/onboarding-mail/smtp-test", {}, () => "SMTP 连接测试成功");
    if (result.response.ok) setData((current) => current ? { ...current, overview: { ...current.overview, smtp: { ...current.overview.smtp, lastSuccessfulTestAt: result.payload.testedAt } } } : current);
  }
  async function initializeTemplate() {
    setInitializingTemplate(true);
    try {
      const response = await fetch("/api/admin/onboarding-mail/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "新人欢迎信" }),
      });
      const payload = await response.json() as { template?: Partial<MailTemplate> & Pick<MailTemplate, "id">; message?: string };
      if (!response.ok || !payload.template) {
        setTodayMessage(payload.message ?? "模板初始化失败");
        return;
      }
      const initialized = {
        enabled: false,
        defaultSendTime: "09:00",
        draftSenderName: null,
        draftSubject: null,
        draftHtmlBody: null,
        draftTextBody: null,
        draftFieldConfig: loadedData.fields,
        draftStyleConfig: {},
        draftAttachments: [],
        draftCcEntries: [],
        currentRevision: null,
        ...payload.template,
      } as MailTemplate;
      setData({ ...loadedData, template: initialized, revisions: [] });
    } finally {
      setInitializingTemplate(false);
    }
  }
  async function toggleAutomation() {
    const next = !loadedData.overview.automation.enabled;
    const count = loadedData.overview.automation.confirmRecipientCount ?? loadedData.overview.today.eligible;
    if (!window.confirm(`${next ? "启用" : "停用"}自动发送；页面显示收件人 ${count} 人。是否继续？`)) return;
    const result = await mutate<{ message?: string; automation: MailCenterData["overview"]["automation"] }>("/api/admin/onboarding-mail/automation", { enabled: next, confirmed: true, displayedRecipientCount: count, confirmationToken: loadedData.overview.confirmations.enableAutomation.token }, () => next ? "自动发送已启用" : "自动发送已停用");
    if (result.response.ok) {
      setPendingAction("automation-overview-refresh");
      try {
        const overview = await getJson<MailCenterData["overview"]>("/api/admin/onboarding-mail/overview");
        setData((current) => current ? { ...current, overview } : current);
      } catch {
        setTodayMessage(`${next ? "自动发送已启用" : "自动发送已停用"}，但状态刷新失败，请刷新页面后继续`);
      } finally {
        setPendingAction(null);
      }
    }
  }

  function handleTabKey(currentTab: Tab, key: string) {
    const currentIndex = tabs.findIndex((item) => item.id === currentTab);
    const nextIndex = key === "ArrowRight" ? (currentIndex + 1) % tabs.length
      : key === "ArrowLeft" ? (currentIndex - 1 + tabs.length) % tabs.length
        : key === "Home" ? 0
          : key === "End" ? tabs.length - 1
            : -1;
    if (nextIndex < 0) return;
    const nextTab = tabs[nextIndex].id;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  async function handleTemplatePublished(
    revision: MailRevision,
    settings: { enabled: boolean; defaultSendTime: string },
  ) {
    const overview = await getJson<MailCenterData["overview"]>("/api/admin/onboarding-mail/overview");
    setData((current) => current?.template ? {
      ...current,
      overview,
      template: {
        ...current.template,
        enabled: settings.enabled,
        defaultSendTime: settings.defaultSendTime,
        currentRevision: { id: revision.id, revisionNumber: revision.revisionNumber },
      },
      revisions: [revision, ...current.revisions.filter((item) => item.id !== revision.id)],
    } : current);
  }

  return (
    <main className="mail-center">
      <header className="mail-center-hero"><div><p className="eyebrow">ONBOARDING MAIL</p><h1>新人欢迎邮件中心</h1><p>从模板、字段到当日队列与投递结果，在一个安全工作台内完成。</p></div><div className="mail-center-status"><span>SMTP {data.overview.smtp.configured ? "已配置" : "未配置"}</span><strong>{data.overview.automation.enabled ? "自动发送已启用" : "自动发送保持关闭"}</strong></div></header>
      <div className="mail-center-tabs" role="tablist" aria-label="邮件中心功能">{tabs.map((item) => <button
        type="button"
        role="tab"
        id={`mail-center-tab-${item.id.toLowerCase()}`}
        aria-controls="mail-center-panel"
        aria-selected={tab === item.id}
        tabIndex={tab === item.id ? 0 : -1}
        key={item.id}
        ref={(element) => { tabRefs.current[item.id] = element; }}
        onKeyDown={(event) => {
          if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) event.preventDefault();
          handleTabKey(item.id, event.key);
        }}
        onClick={() => setTab(item.id)}
      >{item.label}</button>)}</div>
      <div id="mail-center-panel" role="tabpanel" aria-labelledby={`mail-center-tab-${tab.toLowerCase()}`}>
        {tab === "TEMPLATE" ? data.template ? <TemplateEditor
          template={data.template}
          fields={(data.template.draftFieldConfig ?? data.fields) as MailField[]}
          employees={employees}
          revisions={data.revisions}
          assetLibrary={data.assets}
          onPublished={handleTemplatePublished}
        /> : <div className="empty-state"><p>尚未初始化欢迎邮件模板。</p><button type="button" disabled={initializingTemplate} onClick={initializeTemplate}>{initializingTemplate ? "正在初始化…" : "初始化欢迎邮件模板"}</button></div> : null}
        {tab === "FIELDS" ? <CommonFieldManager initialFields={data.fields} /> : null}
        {tab === "TODAY" ? <section className="mail-today-panel">
          <header><div><p className="eyebrow">{data.overview.today.localDate}</p><h2>今日待发送</h2>{data.overview.smtp.lastSuccessfulTestAt ? <small>最近 SMTP 测试成功：{new Date(data.overview.smtp.lastSuccessfulTestAt).toLocaleString("zh-CN")}</small> : null}</div><div className="mail-today-actions"><button type="button" disabled={pendingAction !== null} onClick={smtpTest}>测试 SMTP 连接</button><button type="button" disabled={pendingAction !== null} onClick={toggleAutomation}>{data.overview.automation.enabled ? "停用自动发送" : "启用自动发送"}</button><button type="button" disabled={pendingAction !== null || data.overview.today.eligible === 0} onClick={runToday}>立即运行今日发送</button></div></header>
          <div className="mail-count-cards"><strong>匹配 {data.overview.today.matched} 人</strong><strong>可发送 {data.overview.today.eligible} 人</strong><strong>排除 {data.overview.today.excluded} 人</strong></div>
          <div className="mail-diagnostic-list">{data.overview.today.employees.map((employee) => <article key={employee.id}><div><strong>{employee.name}</strong><span>{employee.employeeNo} · {employee.email ?? "未设置邮箱"}</span></div><b className={employee.eligible ? "mail-ok" : "mail-excluded"}>{employee.eligible ? "符合发送条件" : employee.reasonLabel ?? employee.reason}</b></article>)}</div>
          <section className="mail-missed-panel"><header><div><h3>历史漏发</h3><p>回看窗口内由邮件 worker 自动补建；如需立即处理，可手动发送所选员工。</p></div><button type="button" disabled={pendingAction !== null} onClick={manualMissed}>手动发送所选历史漏发</button></header>{data.overview.truncation?.pastMissed.truncated ? <p role="note">历史漏发仅显示前 100 条，请缩小查询范围或使用后台导出。</p> : null}{data.overview.pastMissed.map((employee) => <label key={employee.id}><input type="checkbox" disabled={pendingAction !== null} aria-label={`选择历史漏发 ${employee.name}`} checked={selectedMissed.includes(employee.id)} onChange={(event) => setSelectedMissed(event.target.checked ? [...selectedMissed, employee.id] : selectedMissed.filter((id) => id !== employee.id))} /><span><strong>{employee.name}</strong><small>{employee.localDate} · {employee.employeeNo}</small></span><b>{employee.reasonLabel}</b></label>)}</section>
          {todayMessage ? <p role="status">{todayMessage}</p> : null}
        </section> : null}
        {tab === "HISTORY" ? <DeliveryHistory initialDeliveries={data.deliveries} localDate={data.overview.today.localDate} truncated={data.deliveriesTruncated} /> : null}
      </div>
    </main>
  );
}

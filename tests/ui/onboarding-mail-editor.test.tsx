// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailCenter } from "@/features/onboarding-mail/components/mail-center";
import { Role } from "@/generated/prisma/enums";
import { AdminSidebar } from "@/lib/ui/admin-sidebar";

const template = {
  id: "template-1",
  name: "新人欢迎信",
  enabled: true,
  defaultSendTime: "09:00",
  draftSenderName: "人力资源部",
  draftSubject: "欢迎 ",
  draftHtmlBody: "<p>欢迎 {{name}}</p>",
  draftTextBody: "欢迎 {{name}}",
  draftFieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
  draftStyleConfig: {},
  draftAttachments: [],
  draftCcEntries: [],
  currentRevision: { id: "revision-2", revisionNumber: 2 },
};

const overview = {
  smtp: { configured: true, lastSuccessfulTestAt: null },
  automation: { enabled: false, enabledAt: null },
  today: {
    localDate: "2026-07-22",
    matched: 2,
    eligible: 1,
    excluded: 1,
    employees: [
      { id: "employee-1", employeeNo: "E001", name: "张敏", email: "zhang@example.invalid", eligible: true },
      { id: "employee-2", employeeNo: "E002", name: "周强", email: null, eligible: false, reason: "NO_EMAIL", reasonLabel: "缺少邮箱" },
    ],
  },
  pastMissed: [
    { id: "past-1", employeeNo: "P001", name: "赵一", localDate: "2026-07-21", reasonLabel: "历史未发送，可手动处理" },
  ],
  confirmations: {
    enableAutomation: { token: "enable-token", expiresAt: "2026-07-22T02:05:00.000Z" },
    enqueueToday: { token: "today-token", expiresAt: "2026-07-22T02:05:00.000Z" },
  },
};

const deliveryRows = [
  {
    id: "failed-1",
    status: "FAILED",
    statusLabel: "发送失败",
    source: "AUTOMATIC",
    recipientEmailSnapshot: "failed@example.invalid",
    failureCode: "SMTP_TRANSPORT_POISONED",
    errorSummary: `{"providerMessageId":"provider-secret", "messageId" : "message-secret", "queueId": "queue-secret"} SMTP transport for secondary@example.invalid ${"x".repeat(220)}`,
    providerMessageId: "must-never-render",
    createdAt: "2026-07-22T02:00:00.000Z",
  },
  { id: "sent-1", status: "SENT", statusLabel: "已发送", source: "MANUAL", recipientEmailSnapshot: "sent@example.invalid", createdAt: "2026-07-22T02:00:00.000Z" },
  { id: "unknown-1", status: "UNKNOWN", statusLabel: "发送调用结果未确认（可能已发出）", source: "AUTOMATIC", recipientEmailSnapshot: "unknown@example.invalid", createdAt: "2026-07-22T02:00:00.000Z" },
];

type TestTemplate = Omit<typeof template, "currentRevision"> & { currentRevision: typeof template.currentRevision | null };

function installFetch(options: { initialTemplate?: TestTemplate | null; retryGate?: Promise<void>; truncated?: boolean; freshWorkflow?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let currentTemplate: TestTemplate | null = options.initialTemplate === undefined ? template : options.initialTemplate;
  let workflowPublished = false;
  let automationEnabled = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body });
    if (url.endsWith("/overview")) {
      const eligible = options.freshWorkflow
        ? workflowPublished && automationEnabled ? overview.today.eligible : 0
        : overview.today.eligible;
      const prospectiveEligible = options.freshWorkflow
        ? workflowPublished ? overview.today.eligible : 0
        : overview.today.eligible;
      return Response.json({
        ok: true,
        ...overview,
        automation: { ...overview.automation, enabled: automationEnabled, confirmRecipientCount: prospectiveEligible },
        today: {
          ...overview.today,
          eligible,
          excluded: overview.today.matched - eligible,
          employees: overview.today.employees.map((employee, index) => index === 0
            ? { ...employee, eligible: eligible === 1, ...(eligible === 1 ? {} : workflowPublished
              ? { reason: "AUTOMATION_OFF", reasonLabel: "自动发送未启用" }
              : { reason: "TEMPLATE_DISABLED", reasonLabel: "模板未启用或未发布" }) }
            : employee),
        },
        confirmations: {
          ...overview.confirmations,
          enableAutomation: {
            ...overview.confirmations.enableAutomation,
            token: options.freshWorkflow
              ? workflowPublished ? "fresh-enable-token" : "stale-enable-token"
              : overview.confirmations.enableAutomation.token,
          },
          enqueueToday: {
            ...overview.confirmations.enqueueToday,
            token: options.freshWorkflow
              ? automationEnabled ? "fresh-today-token" : "stale-today-token"
              : overview.confirmations.enqueueToday.token,
          },
        },
        truncation: { pastMissed: { limit: 100, truncated: options.truncated ?? false } },
      });
    }
    if (url.endsWith("/templates") && method === "GET") return Response.json({ ok: true, template: currentTemplate });
    if (url.endsWith("/templates") && method === "POST") {
      currentTemplate = { ...template, enabled: false, draftSenderName: "", draftSubject: "", draftHtmlBody: "", draftTextBody: "", currentRevision: null };
      return Response.json({ ok: true, template: currentTemplate }, { status: 201 });
    }
    if (url.endsWith("/templates") && method === "PATCH") return Response.json({ ok: true, template: currentTemplate });
    if (url.endsWith("/fields") && method === "GET") return Response.json({ ok: true, fields: template.draftFieldConfig });
    if (url.endsWith("/fields") && method === "PATCH") return Response.json({ ok: true, fields: body.fields });
    if (url.endsWith("/assets") && method === "GET") return Response.json({ ok: true, assets: [], materials: [{ id: "material-1", title: "入职手册", currentVersion: { id: "material-version-1", displayName: "入职手册.pdf", mimeType: "application/pdf", sizeBytes: 500 } }] });
    if (url.endsWith("/assets") && method === "POST") {
      const form = init?.body as FormData;
      return Response.json({ ok: true, asset: { id: `asset-${form.get("contentId") ?? "attachment"}`, originalName: (form.get("file") as File).name, mimeType: "image/png", sizeBytes: 100, role: form.get("role"), contentId: form.get("contentId") } }, { status: 201 });
    }
    if (url.includes("/deliveries")) return Response.json({ ok: true, deliveries: deliveryRows, truncation: { deliveries: { limit: 200, truncated: options.truncated ?? false } } });
    if (url.includes("/revisions") && method === "GET") return Response.json({ ok: true, revisions: [{ id: "revision-2", revisionNumber: 2, subject: "第二版" }, { id: "revision-1", revisionNumber: 1, subject: "第一版" }] });
    if (url.endsWith("/revisions") && method === "POST") {
      workflowPublished = true;
      if (currentTemplate) currentTemplate = {
        ...currentTemplate,
        enabled: body.enabled ?? currentTemplate.enabled,
        defaultSendTime: body.defaultSendTime ?? currentTemplate.defaultSendTime,
        currentRevision: { id: "revision-3", revisionNumber: 3 },
      };
      return Response.json({ ok: true, revision: { id: "revision-3", revisionNumber: 3 } }, { status: 201 });
    }
    if (url.includes("/cc-search")) return Response.json({ ok: true, candidates: [
      { userId: "cc-1", employeeNo: "CC-001", name: "李晨", email: "li-1@example.invalid", label: "李晨（CC-001 · li-1@example.invalid）" },
      { userId: "cc-2", employeeNo: "CC-002", name: "李晨", email: "li-2@example.invalid", label: "李晨（CC-002 · li-2@example.invalid）" },
    ] });
    if (url.endsWith("/preview")) return Response.json({ ok: true, preview: { subject: "欢迎 张敏", html: "<p>欢迎 张敏</p>", text: "欢迎 张敏", recipient: { employeeId: "employee-1", name: "张敏", email: "zhang@example.invalid" } } });
    if (url.endsWith("/smtp-test")) return Response.json({ ok: true, testedAt: "2026-07-22T02:00:00.000Z" });
    if (url.endsWith("/test-send")) return Response.json({ ok: true, delivery: { id: "test-1", testMailbox: body.testMailbox } }, { status: 201 });
    if (url.endsWith("/automation")) {
      if (options.freshWorkflow && body.enabled && body.confirmationToken !== "fresh-enable-token") {
        return Response.json({ ok: false, code: "CONFIRMATION_MISMATCH", message: "页面人数已变化，请刷新后重试" }, { status: 409 });
      }
      automationEnabled = body.enabled;
      return Response.json({ ok: true, automation: { enabled: body.enabled, enabledAt: "2026-07-22T02:00:00.000Z" } });
    }
    if (url.endsWith("/confirmations")) return Response.json({ ok: true, confirmationToken: `${body.action}-server-token`, count: body.selectedIds.length, expiresAt: "2026-07-22T02:05:00.000Z" });
    if (url.endsWith("/enqueue-today")) return Response.json({ ok: true, summary: { enqueued: 1 } }, { status: 201 });
    if (url.endsWith("/manual-send")) return Response.json({ ok: true, created: 1 }, { status: 201 });
    if (url.endsWith("/retry")) {
      if (options.retryGate) await options.retryGate;
      return Response.json({ ok: true, retried: 1 });
    }
    if (url.endsWith("/resend")) return Response.json({ ok: true, created: 1 }, { status: 201 });
    if (url.includes("/unknown/") && url.endsWith("/resolve")) return Response.json({ ok: true, result: { deliveryId: "unknown-1" } });
    throw new Error(`Unhandled fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function renderLoaded() {
  const harness = installFetch();
  render(<MailCenter />);
  await screen.findByRole("heading", { name: "新人欢迎邮件中心" });
  await screen.findByDisplayValue("人力资源部");
  return harness;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("onboarding mail center interactions", () => {
  it.each([Role.ADMIN, Role.SUPER_ADMIN])("links %s administrators to the same mail center", (role) => {
    render(<AdminSidebar role={role} />);
    expect(screen.getByRole("link", { name: "欢迎邮件" }).getAttribute("href")).toBe("/admin/onboarding-mail");
  });

  it("initializes and edits a welcome template from a fresh UI state", async () => {
    const { calls } = installFetch({ initialTemplate: null, freshWorkflow: true });
    render(<MailCenter />);
    await screen.findByRole("heading", { name: "新人欢迎邮件中心" });

    fireEvent.click(screen.getByRole("button", { name: "初始化欢迎邮件模板" }));
    const sender = await screen.findByLabelText("发件人显示名");
    await userEvent.type(sender, "人力资源部");
    fireEvent.change(screen.getByLabelText("邮件主题"), { target: { value: "欢迎 {{name}}" } });
    fireEvent.change(screen.getByLabelText("纯文本备用正文"), { target: { value: "欢迎 {{name}}" } });
    fireEvent.click(screen.getByLabelText("模板启用"));
    fireEvent.change(screen.getByLabelText("默认发送时间"), { target: { value: "10:30" } });
    fireEvent.change(screen.getByLabelText("预览员工"), { target: { value: "employee-1" } });
    fireEvent.click(screen.getByRole("button", { name: "员工预览" }));
    expect(await screen.findByRole("heading", { name: "欢迎 张敏" })).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith("/templates") && call.method === "POST")).toBe(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    expect(await screen.findByText("版本 3 已发布")).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/revisions") && call.method === "POST")?.body).toMatchObject({
      enabled: true,
      defaultSendTime: "10:30",
      draft: { senderDisplayName: "人力资源部", subject: "欢迎 {{name}}", textBody: "欢迎 {{name}}" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "今日待发送" }));
    fireEvent.click(screen.getByRole("tab", { name: "邮件模板" }));
    await userEvent.type(screen.getByLabelText("专用测试邮箱"), "fresh@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "发送测试邮件" }));
    expect(await screen.findByText("测试邮件已加入队列：fresh@example.invalid")).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/test-send"))?.body).toMatchObject({ templateRevisionId: "revision-3" });
    fireEvent.click(screen.getByRole("tab", { name: "今日待发送" }));
    fireEvent.click(screen.getByRole("button", { name: "测试 SMTP 连接" }));
    expect(await screen.findByText("SMTP 连接测试成功")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "启用自动发送" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("自动发送已启用"));
    expect(calls.filter((call) => call.url.endsWith("/automation")).at(-1)?.body).toMatchObject({
      enabled: true,
      displayedRecipientCount: 1,
      confirmationToken: "fresh-enable-token",
    });
    const runToday = screen.getByRole("button", { name: "立即运行今日发送" }) as HTMLButtonElement;
    expect(runToday.disabled).toBe(false);
    fireEvent.click(runToday);
    expect(await screen.findByText("已创建 1 封今日邮件")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/enqueue-today")).at(-1)?.body).toMatchObject({
      displayedRecipientCount: 1,
      confirmationToken: "fresh-today-token",
    });
  });

  it("provides four tabs, cursor-aware field chips, CC disambiguation, asset roles, preview, draft, publish and history", async () => {
    const { calls } = await renderLoaded();
    for (const tab of ["邮件模板", "常用字段", "今日待发送", "发送记录"]) expect(screen.getByRole("tab", { name: tab })).toBeTruthy();
    const templateTab = screen.getByRole("tab", { name: "邮件模板" });
    const fieldsTab = screen.getByRole("tab", { name: "常用字段" });
    expect(templateTab.getAttribute("tabindex")).toBe("0");
    expect(fieldsTab.getAttribute("tabindex")).toBe("-1");
    expect(templateTab.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
    fireEvent.keyDown(templateTab, { key: "ArrowRight" });
    expect(fieldsTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(fieldsTab);
    fireEvent.click(templateTab);
    const subject = screen.getByLabelText("邮件主题") as HTMLInputElement;
    subject.focus();
    subject.setSelectionRange(subject.value.length, subject.value.length);
    fireEvent.click(screen.getByRole("button", { name: "插入字段 姓名" }));
    expect(subject.value).toBe("欢迎 {{name}}");

    await userEvent.type(screen.getByLabelText("抄送姓名或邮箱"), "李晨");
    fireEvent.click(screen.getByRole("button", { name: "搜索抄送" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择 李晨（CC-002 · li-2@example.invalid）" }));
    expect(screen.getByText("李晨（CC-002 · li-2@example.invalid）")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("抄送姓名或邮箱"), "broken@");
    fireEvent.click(screen.getByRole("button", { name: "添加外部邮箱" }));
    expect(await screen.findByText("邮箱地址格式无效")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("抄送姓名或邮箱"), { target: { value: "External@Example.Invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "添加外部邮箱" }));
    expect(screen.getByText("external@example.invalid")).toBeTruthy();
    for (const role of ["邮件背景", "内嵌图片", "普通附件"]) expect(screen.getByRole("radio", { name: role })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "富文本正文" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "加粗" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("邮件素材文件"), { target: { files: [new File(["png"], "background.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByLabelText("素材 Content-ID"), { target: { value: "welcome-background" } });
    fireEvent.click(screen.getByRole("button", { name: "上传并添加素材" }));
    expect(await screen.findByText("background.png · 邮件背景")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "内嵌图片" }));
    fireEvent.change(screen.getByLabelText("邮件素材文件"), { target: { files: [new File(["png"], "body.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByLabelText("素材 Content-ID"), { target: { value: "welcome-body" } });
    fireEvent.click(screen.getByRole("button", { name: "上传并添加素材" }));
    fireEvent.click(await screen.findByRole("button", { name: "插入图片 body.png" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "富文本正文" }).querySelector('img[src="cid:welcome-body"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText("已发布入职资料"), { target: { value: "material-version-1" } });
    fireEvent.click(screen.getByRole("button", { name: "添加资料附件" }));
    expect(screen.getByText("入职手册.pdf · 普通附件")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("预览员工"), { target: { value: "employee-1" } });
    fireEvent.click(screen.getByRole("button", { name: "员工预览" }));
    expect(await screen.findByRole("heading", { name: "欢迎 张敏" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("草稿已保存")).toBeTruthy();
    const savedDraft = calls.find((call) => call.url.endsWith("/templates") && call.method === "PATCH")?.body as { draft: { htmlBody: string; styleConfig: Record<string, unknown>; attachments: Array<Record<string, unknown>>; ccEntries: Array<Record<string, unknown>> } };
    expect(savedDraft.draft.attachments).toEqual([
      expect.objectContaining({ role: "INLINE_BACKGROUND", fileAssetId: "asset-welcome-background", contentId: "welcome-background" }),
      expect.objectContaining({ role: "INLINE_BODY", fileAssetId: "asset-welcome-body", contentId: "welcome-body" }),
      expect.objectContaining({ role: "ATTACHMENT", materialVersionId: "material-version-1" }),
    ]);
    expect(savedDraft.draft.styleConfig).toMatchObject({ backgroundContentId: "welcome-background" });
    expect(savedDraft.draft.htmlBody).toContain('src="cid:welcome-body"');
    expect(savedDraft.draft.ccEntries).toEqual([
      expect.objectContaining({ kind: "USER", userId: "cc-2" }),
      expect.objectContaining({ kind: "EMAIL", email: "external@example.invalid" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "移除素材 background.png" }));
    expect(screen.queryByText("background.png · 邮件背景")).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    expect(await screen.findByText("版本 3 已发布")).toBeTruthy();
    expect(screen.getByText("版本 2 · 第二版")).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith("/preview"))).toBe(true);
  });

  it("shows today eligibility/exclusion reasons and keeps past missed rows unselected", async () => {
    const { calls } = await renderLoaded();
    fireEvent.click(screen.getByRole("tab", { name: "今日待发送" }));
    expect(screen.getByText("可发送 1 人")).toBeTruthy();
    expect(screen.getByText("排除 1 人")).toBeTruthy();
    expect(screen.getByText("缺少邮箱")).toBeTruthy();
    expect(screen.getByText("回看窗口内由邮件 worker 自动补建；如需立即处理，可手动发送所选员工。")).toBeTruthy();
    const missed = screen.getByRole("checkbox", { name: "选择历史漏发 赵一" }) as HTMLInputElement;
    expect(missed.checked).toBe(false);
    expect(screen.getByText("历史未发送，可手动处理")).toBeTruthy();

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "立即运行今日发送" }));
    expect(calls.some((call) => call.url.endsWith("/enqueue-today"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "立即运行今日发送" }));
    expect(await screen.findByText("已创建 1 封今日邮件")).toBeTruthy();
    expect((screen.getByRole("button", { name: "立即运行今日发送" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(missed);
    fireEvent.click(screen.getByRole("button", { name: "手动发送所选历史漏发" }));
    expect(await screen.findByText("已创建 1 封手动邮件")).toBeTruthy();
    const manual = calls.find((call) => call.url.endsWith("/manual-send"));
    expect(calls.find((call) => call.url.endsWith("/confirmations") && (call.body as { action?: string }).action === "MANUAL_SEND")?.body).toMatchObject({
      action: "MANUAL_SEND", localDate: "2026-07-21", selectedIds: ["past-1"],
    });
    expect(manual?.body).toMatchObject({ employeeIds: ["past-1"], localDate: "2026-07-21", displayedRecipientCount: 1, confirmationToken: "MANUAL_SEND-server-token" });
    expect(screen.queryByRole("checkbox", { name: "选择历史漏发 赵一" })).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("labels UNKNOWN conservatively and never mixes its two audited actions into retry", async () => {
    const { calls } = await renderLoaded();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));
    fireEvent.change(screen.getByLabelText("发送状态筛选"), { target: { value: "UNKNOWN" } });
    const unknownRow = screen.getByTestId("delivery-unknown-1");
    expect(within(unknownRow).getByText("发送调用结果未确认（可能已发出）")).toBeTruthy();
    expect(within(unknownRow).queryByRole("button", { name: "重试" })).toBeNull();
    fireEvent.click(within(unknownRow).getByRole("button", { name: "确认已送达" }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("/unknown/unknown-1/resolve") && (call.body as { action: string }).action === "CONFIRMED_DELIVERED")).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId("delivery-unknown-1")).queryByRole("button", { name: "确认已送达" })).toBeNull());

    fireEvent.change(screen.getByLabelText("发送状态筛选"), { target: { value: "FAILED" } });
    fireEvent.click(within(screen.getByTestId("delivery-failed-1")).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByTestId("delivery-failed-1")).toBeNull());
    fireEvent.change(screen.getByLabelText("发送状态筛选"), { target: { value: "SENT" } });
    fireEvent.click(within(screen.getByTestId("delivery-sent-1")).getByRole("button", { name: "再次发送" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/retry"))).toBe(true));
    expect(calls.find((call) => call.url.endsWith("/confirmations") && (call.body as { action?: string }).action === "RESEND")?.body).toMatchObject({
      action: "RESEND", localDate: "2026-07-22", selectedIds: ["sent-1"],
    });
    expect(calls.find((call) => call.url.endsWith("/resend"))?.body).toMatchObject({ confirmationToken: "RESEND-server-token" });
    await waitFor(() => expect(within(screen.getByTestId("delivery-sent-1")).queryByRole("button", { name: "再次发送" })).toBeNull());
  });

  it("shows a bounded redacted failure diagnostic without exposing provider identifiers", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));

    const failedRow = screen.getByTestId("delivery-failed-1");
    expect(within(failedRow).getByText("SMTP_TRANSPORT_POISONED")).toBeTruthy();
    const summary = failedRow.querySelector(".mail-failure-summary");
    expect(summary?.textContent).toContain("[redacted-email]");
    expect(summary?.textContent?.length).toBeLessThanOrEqual(181);
    expect(failedRow.textContent).toContain("failed@example.invalid");
    expect(failedRow.textContent).not.toContain("secondary@example.invalid");
    expect(failedRow.textContent).not.toContain("provider-secret");
    expect(failedRow.textContent).not.toContain("message-secret");
    expect(failedRow.textContent).not.toContain("queue-secret");
    expect(failedRow.textContent).not.toContain("must-never-render");
  });

  it("requires an explicit test mailbox and exposes SMTP-tested automation confirmation", async () => {
    const { calls } = await renderLoaded();
    const initialOverviewReads = calls.filter((call) => call.url.endsWith("/overview") && call.method === "GET").length;
    fireEvent.click(screen.getByRole("button", { name: "发送测试邮件" }));
    expect(await screen.findByText("请输入专用测试邮箱")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("专用测试邮箱"), "qa@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "发送测试邮件" }));
    expect(await screen.findByText("测试邮件已加入队列：qa@example.invalid")).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/test-send"))?.body).toMatchObject({ testMailbox: "qa@example.invalid", employeeId: "employee-1" });

    fireEvent.click(screen.getByRole("tab", { name: "今日待发送" }));
    fireEvent.click(screen.getByRole("button", { name: "测试 SMTP 连接" }));
    expect(await screen.findByText("SMTP 连接测试成功")).toBeTruthy();
    expect(screen.getByText(/最近 SMTP 测试成功/)).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "启用自动发送" }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith("/automation"))?.body).toMatchObject({ enabled: true, displayedRecipientCount: 1, confirmationToken: "enable-token" }));
    fireEvent.click(await screen.findByRole("button", { name: "停用自动发送" }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/automation")).at(-1)?.body).toMatchObject({ enabled: false }));
    await screen.findByRole("button", { name: "启用自动发送" });
    expect(calls.filter((call) => call.url.endsWith("/overview") && call.method === "GET")).toHaveLength(initialOverviewReads + 2);
  });

  it("disables a delivery mutation while its request is pending", async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    installFetch({ retryGate });
    render(<MailCenter />);
    await screen.findByRole("heading", { name: "新人欢迎邮件中心" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));
    const retryButton = within(await screen.findByTestId("delivery-failed-1")).getByRole("button", { name: "重试" });
    fireEvent.click(retryButton);
    expect((retryButton as HTMLButtonElement).disabled).toBe(true);
    releaseRetry();
    await waitFor(() => expect(within(screen.getByTestId("delivery-failed-1")).queryByRole("button", { name: "重试" })).toBeNull());
  });

  it("warns when operational lists are truncated", async () => {
    installFetch({ truncated: true });
    render(<MailCenter />);
    await screen.findByRole("heading", { name: "新人欢迎邮件中心" });
    fireEvent.click(screen.getByRole("tab", { name: "今日待发送" }));
    expect(screen.getByText("历史漏发仅显示前 100 条，请缩小查询范围或使用后台导出。")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));
    expect(screen.getByText("发送记录仅显示最近 200 条，请使用状态筛选缩小范围。")).toBeTruthy();
  });
});

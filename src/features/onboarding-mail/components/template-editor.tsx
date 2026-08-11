"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { CcPicker, type SelectedCc } from "@/features/onboarding-mail/components/cc-picker";
import type { MailField } from "@/features/onboarding-mail/components/common-field-manager";

export type MailEmployee = { id: string; employeeNo: string; name: string; email: string | null };
export type MailRevision = { id: string; revisionNumber: number; subject: string };
type AttachmentRole = "ATTACHMENT" | "INLINE_LOGO" | "INLINE_BACKGROUND" | "INLINE_BODY";
type Attachment = { role: AttachmentRole; fileAssetId?: string; materialVersionId?: string; displayName: string; contentId?: string; sortOrder: number };
export type AssetLibrary = { assets: Array<{ id: string; originalName: string; mimeType: string; sizeBytes: number }>; materials: Array<{ id: string; title: string; currentVersion: { id: string; displayName: string; mimeType: string; sizeBytes: number } | null }> };
export type MailTemplate = {
  id: string; enabled: boolean; defaultSendTime: string; draftSenderName: string | null; draftSubject: string | null;
  draftHtmlBody: string | null; draftTextBody: string | null; draftFieldConfig: MailField[] | null; draftStyleConfig: unknown;
  draftAttachments: Array<Attachment & { id?: string }>;
  draftCcEntries: Array<
    | { kind: "USER"; userId: string; displayName?: string | null; sortOrder: number }
    | { kind: "EMAIL"; email: string; displayName?: string | null; sortOrder: number }
  >;
  currentRevision: { id: string; revisionNumber: number } | null;
};

const RichTextEditor = dynamic(() => import("@/features/onboarding-mail/components/rich-text-editor").then((module) => module.RichTextEditor), {
  ssr: false,
  loading: () => <div className="mail-rich-editor-loading" role="status">正在加载富文本编辑器…</div>,
});

const roleLabels: Record<AttachmentRole, string> = { ATTACHMENT: "普通附件", INLINE_LOGO: "内嵌图片", INLINE_BACKGROUND: "邮件背景", INLINE_BODY: "内嵌图片" };

export function TemplateEditor({ template, fields, employees, revisions, assetLibrary, onPublished }: {
  template: MailTemplate;
  fields: MailField[];
  employees: MailEmployee[];
  revisions: MailRevision[];
  assetLibrary: AssetLibrary;
  onPublished?: (revision: MailRevision, settings: { enabled: boolean; defaultSendTime: string }) => void | Promise<void>;
}) {
  const [sender, setSender] = useState(template.draftSenderName ?? "");
  const [subject, setSubject] = useState(template.draftSubject ?? "");
  const [html, setHtml] = useState(template.draftHtmlBody ?? "");
  const [text, setText] = useState(template.draftTextBody ?? "");
  const [styleConfig, setStyleConfig] = useState<Record<string, unknown>>(
    template.draftStyleConfig && typeof template.draftStyleConfig === "object" ? template.draftStyleConfig as Record<string, unknown> : {},
  );
  const [enabled, setEnabled] = useState(template.enabled);
  const [sendTime, setSendTime] = useState(template.defaultSendTime);
  const [cc, setCc] = useState<SelectedCc[]>(template.draftCcEntries.map((entry) => entry.kind === "USER"
    ? { ...entry, displayName: entry.displayName ?? "", label: entry.displayName ?? entry.userId }
    : { ...entry, displayName: entry.displayName ?? undefined, label: entry.displayName ?? entry.email }));
  const [assetRole, setAssetRole] = useState("INLINE_BACKGROUND");
  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [contentId, setContentId] = useState("");
  const [materialVersionId, setMaterialVersionId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>(template.draftAttachments.map((item, index) => ({
    role: item.role,
    ...(item.fileAssetId ? { fileAssetId: item.fileAssetId } : {}),
    ...(item.materialVersionId ? { materialVersionId: item.materialVersionId } : {}),
    displayName: item.displayName,
    ...(item.contentId ? { contentId: item.contentId } : {}),
    sortOrder: item.sortOrder ?? index + 1,
  })));
  const [employeeId, setEmployeeId] = useState(employees.find((item) => item.email)?.id ?? "");
  const [testMailbox, setTestMailbox] = useState("");
  const [preview, setPreview] = useState<{ subject: string; html: string; text: string } | null>(null);
  const [message, setMessage] = useState("");
  const [published, setPublished] = useState(revisions);
  const [currentRevision, setCurrentRevision] = useState(template.currentRevision);
  const [pending, setPending] = useState(false);
  const [imageRequest, setImageRequest] = useState<{ contentId: string; alt: string; nonce: number } | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const imageNonceRef = useRef(0);

  const draft = () => ({
    templateId: template.id,
    senderDisplayName: sender,
    subject,
    htmlBody: html,
    textBody: text,
    fieldConfig: fields,
    styleConfig,
    attachments,
    ccEntries: cc.map((entry) => entry.kind === "USER"
      ? { kind: entry.kind, userId: entry.userId, displayName: entry.displayName, sortOrder: entry.sortOrder }
      : { kind: entry.kind, email: entry.email, displayName: entry.displayName, sortOrder: entry.sortOrder }),
  });

  function insertField(field: MailField) {
    const input = subjectRef.current;
    const token = `{{${field.key}}}`;
    const start = input?.selectionStart ?? subject.length;
    const end = input?.selectionEnd ?? start;
    setSubject(`${subject.slice(0, start)}${token}${subject.slice(end)}`);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + token.length, start + token.length); });
  }

  async function jsonAction<T extends { message?: string }>(url: string, body: unknown, success: (payload: T) => string) {
    setPending(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as T;
      setMessage(response.ok ? success(payload) : payload.message ?? "操作失败");
      return { response, payload };
    } finally {
      setPending(false);
    }
  }

  async function save() {
    setPending(true);
    try {
      const response = await fetch("/api/admin/onboarding-mail/templates", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: draft(), enabled, defaultSendTime: sendTime }) });
      const payload = await response.json();
      setMessage(response.ok ? "草稿已保存" : payload.message ?? "保存失败");
    } finally {
      setPending(false);
    }
  }

  async function publish() {
    if (!window.confirm("发布后将创建不可变的新版本，是否继续？")) return;
    const result = await jsonAction<{ message?: string; revision: { id: string; revisionNumber: number } }>("/api/admin/onboarding-mail/revisions", {
      draft: draft(), confirmed: true, enabled, defaultSendTime: sendTime,
    }, (payload) => `版本 ${payload.revision.revisionNumber} 已发布`);
    if (result.response.ok) {
      const revision = { id: result.payload.revision.id, revisionNumber: result.payload.revision.revisionNumber };
      setCurrentRevision(revision);
      const publishedRevision = { ...revision, subject };
      setPublished((items) => [publishedRevision, ...items]);
      if (onPublished) {
        setPending(true);
        try {
          await onPublished(publishedRevision, { enabled, defaultSendTime: sendTime });
        } catch {
          setMessage(`版本 ${revision.revisionNumber} 已发布，但状态刷新失败，请刷新页面后继续`);
        } finally {
          setPending(false);
        }
      }
    }
  }

  async function showPreview() {
    if (!employeeId) { setMessage("请选择预览员工"); return; }
    const result = await jsonAction<{ message?: string; preview: { subject: string; html: string; text: string } }>("/api/admin/onboarding-mail/preview", { draft: draft(), employeeId }, () => "预览已生成");
    if (result.response.ok) setPreview(result.payload.preview);
  }

  async function sendTest() {
    if (!testMailbox.trim()) { setMessage("请输入专用测试邮箱"); return; }
    if (!employeeId || !currentRevision?.id) { setMessage("请先发布模板并选择预览员工"); return; }
    await jsonAction<{ message?: string; delivery: { testMailbox: string } }>("/api/admin/onboarding-mail/test-send", { employeeId, templateRevisionId: currentRevision.id, testMailbox: testMailbox.trim(), confirmed: true }, (payload) => `测试邮件已加入队列：${payload.delivery.testMailbox}`);
  }

  async function uploadAsset() {
    if (!assetFile) { setMessage("请选择邮件素材文件"); return; }
    const inline = assetRole !== "ATTACHMENT";
    if (inline && !contentId.trim()) { setMessage("内嵌素材需要 Content-ID"); return; }
    setPending(true);
    try {
      const form = new FormData();
      form.set("role", assetRole);
      if (inline) form.set("contentId", contentId.trim());
      form.set("file", assetFile);
      const response = await fetch("/api/admin/onboarding-mail/assets", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) { setMessage(payload.message ?? "素材上传失败"); return; }
      const uploaded: Attachment = {
        role: assetRole as AttachmentRole,
        fileAssetId: payload.asset.id,
        displayName: payload.asset.originalName,
        ...(payload.asset.contentId ? { contentId: payload.asset.contentId } : {}),
        sortOrder: attachments.length + 1,
      };
      setAttachments([...attachments, uploaded]);
      if (uploaded.role === "INLINE_BACKGROUND" && uploaded.contentId) {
        setStyleConfig({ ...styleConfig, backgroundContentId: uploaded.contentId });
      }
      setAssetFile(null);
      setContentId("");
      setMessage("邮件素材已上传并加入模板");
    } finally {
      setPending(false);
    }
  }

  function addMaterial() {
    const material = assetLibrary.materials.find((item) => item.currentVersion?.id === materialVersionId)?.currentVersion;
    if (!material) { setMessage("请选择已发布入职资料"); return; }
    if (attachments.some((item) => item.materialVersionId === material.id)) return;
    setAttachments([...attachments, { role: "ATTACHMENT", materialVersionId: material.id, displayName: material.displayName, sortOrder: attachments.length + 1 }]);
    setMessage("入职资料已作为附件加入模板");
  }

  function removeAttachment(index: number) {
    const removed = attachments[index];
    setAttachments(attachments.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, sortOrder: itemIndex + 1 })));
    if (removed.role === "INLINE_BACKGROUND" && styleConfig.backgroundContentId === removed.contentId) {
      const remainingStyles = { ...styleConfig };
      delete remainingStyles.backgroundContentId;
      setStyleConfig(remainingStyles);
    }
    if (removed.role === "INLINE_BODY" && removed.contentId) {
      const escaped = removed.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      setHtml(html.replace(new RegExp(`<img\\b[^>]*src=["']cid:${escaped}["'][^>]*>`, "gi"), ""));
    }
  }

  function insertInlineImage(attachment: Attachment) {
    if (!attachment.contentId || attachment.role !== "INLINE_BODY") return;
    imageNonceRef.current += 1;
    setImageRequest({ contentId: attachment.contentId, alt: attachment.displayName, nonce: imageNonceRef.current });
  }

  return (
    <section className="mail-template-layout">
      <div className="mail-template-editor">
        <header><div><p className="eyebrow">模板工作台</p><h2>新人欢迎邮件</h2></div><label className="mail-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />模板启用</label></header>
        <div className="mail-field-chips" aria-label="可插入字段">{fields.filter((field) => field.enabled).map((field) => <button type="button" key={field.key} aria-label={`插入字段 ${field.label}`} onClick={() => insertField(field)}>{field.label} · {`{{${field.key}}}`}</button>)}</div>
        <div className="mail-form-grid">
          <label>发件人显示名<input value={sender} onChange={(event) => setSender(event.target.value)} /></label>
          <label>默认发送时间<input type="time" value={sendTime} onChange={(event) => setSendTime(event.target.value)} /></label>
          <label className="mail-wide">邮件主题<input ref={subjectRef} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
          <div className="mail-wide"><span className="mail-editor-label">富文本正文</span><RichTextEditor value={html} onChange={setHtml} imageRequest={imageRequest} /></div>
          <label className="mail-wide">纯文本备用正文<textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} /></label>
        </div>
        <CcPicker value={cc} onChange={setCc} />
        <fieldset className="mail-asset-roles"><legend>素材用途</legend>{[["INLINE_BACKGROUND", "邮件背景"], ["INLINE_BODY", "内嵌图片"], ["ATTACHMENT", "普通附件"]].map(([value, label]) => <label key={value}><input type="radio" name="asset-role" value={value} checked={assetRole === value} onChange={() => setAssetRole(value)} />{label}</label>)}</fieldset>
        <section className="mail-asset-manager" aria-label="模板素材与附件">
          <div className="mail-asset-upload"><label>邮件素材文件<input type="file" accept={assetRole === "ATTACHMENT" ? undefined : "image/png,image/jpeg,image/gif,image/webp"} onChange={(event) => setAssetFile(event.target.files?.[0] ?? null)} /></label>{assetRole !== "ATTACHMENT" ? <label>素材 Content-ID<input value={contentId} onChange={(event) => setContentId(event.target.value)} placeholder="例如 welcome-background" /></label> : null}<button type="button" disabled={pending} onClick={uploadAsset}>上传并添加素材</button></div>
          <div className="mail-material-picker"><label>已发布入职资料<select value={materialVersionId} onChange={(event) => setMaterialVersionId(event.target.value)}><option value="">请选择资料版本</option>{assetLibrary.materials.flatMap((material) => material.currentVersion ? [<option key={material.currentVersion.id} value={material.currentVersion.id}>{material.title} · {material.currentVersion.displayName}</option>] : [])}</select></label><button type="button" onClick={addMaterial}>添加资料附件</button></div>
          <div className="mail-attachment-list">{attachments.map((attachment, index) => <article key={`${attachment.fileAssetId ?? attachment.materialVersionId}-${index}`}><span>{attachment.displayName} · {roleLabels[attachment.role]}</span>{attachment.contentId ? <code>{attachment.contentId}</code> : null}{attachment.role === "INLINE_BODY" ? <button type="button" aria-label={`插入图片 ${attachment.displayName}`} onClick={() => insertInlineImage(attachment)}>插入正文</button> : null}<button type="button" aria-label={`移除素材 ${attachment.displayName}`} onClick={() => removeAttachment(index)}>移除</button></article>)}</div>
        </section>
        <div className="mail-preview-controls"><label>预览员工<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">请选择</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.employeeNo}</option>)}</select></label><button type="button" disabled={pending} onClick={showPreview}>员工预览</button></div>
        {preview ? <article className="mail-preview" aria-label="员工邮件预览"><h3>{preview.subject}</h3><div dangerouslySetInnerHTML={{ __html: preview.html }} /><pre>{preview.text}</pre></article> : null}
        <div className="mail-test-send"><label>专用测试邮箱<input type="email" value={testMailbox} onChange={(event) => setTestMailbox(event.target.value)} /></label><button type="button" disabled={pending} onClick={sendTest}>发送测试邮件</button><small>测试邮件只发送到上方明确填写的邮箱，不会推断真实员工收件地址。</small></div>
        <footer><button type="button" disabled={pending} onClick={save}>保存草稿</button><button type="button" disabled={pending} onClick={publish}>发布新版本</button></footer>
        {message ? <p role="status">{message}</p> : null}
      </div>
      <aside className="mail-revision-history" aria-label="版本历史"><h2>版本历史</h2>{published.map((revision) => <article key={revision.id}><strong>版本 {revision.revisionNumber} · {revision.subject}</strong><span>不可变发布快照</span></article>)}</aside>
    </section>
  );
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Calendar, Upload } from "lucide-react";
import { FilePickerButton } from "@/lib/ui/file-picker-button";

type PolicyVersion = {
  id: string;
  versionNumber: string;
  effectiveDate: string;
  previewStatus: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  previewFormat: string | null;
  previewError: string | null;
};

type Policy = {
  id: string;
  name: string;
  category: string;
  status: string;
  sortOrder: number;
  versions: PolicyVersion[];
};

type RecycledPolicy = {
  id: string;
  name: string;
  category: string;
  deletedAt: string | null;
  statusBeforeDelete: string | null;
  versions: PolicyVersion[];
};

type RecycledPolicyVersion = PolicyVersion & {
  deletedAt: string | null;
  policy: { id: string; name: string; category: string; status: string };
};

type DeleteDialog = {
  policy: Policy;
  mode: "choose" | "version" | "whole";
};

export function PolicyAdmin() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [message, setMessage] = useState("");
  const [environment, setEnvironment] = useState<{ available: boolean; chineseFontAvailable: boolean; version?: string } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [recyclePolicies, setRecyclePolicies] = useState<RecycledPolicy[]>([]);
  const [recycleVersions, setRecycleVersions] = useState<RecycledPolicyVersion[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/admin/policies");
    const result = await response.json() as { policies?: Policy[]; previewEnvironment?: { available: boolean; chineseFontAvailable: boolean; version?: string } };
    setPolicies(result.policies ?? []);
    setEnvironment(result.previewEnvironment ?? null);
  }

  async function loadRecycleBin() {
    const response = await fetch("/api/admin/policies/recycle-bin");
    const result = await response.json() as { policies?: RecycledPolicy[]; versions?: RecycledPolicyVersion[] };
    setRecyclePolicies(result.policies ?? []);
    setRecycleVersions(result.versions ?? []);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/policies", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { policies?: Policy[]; previewEnvironment?: { available: boolean; chineseFontAvailable: boolean; version?: string } }) => {
        setPolicies(result.policies ?? []);
        setEnvironment(result.previewEnvironment ?? null);
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch("/api/admin/policies", { method: "POST", body: new FormData(form) });
    const result = await response.json() as { ok: boolean; message?: string };
    setMessage(result.ok ? "制度草稿已创建" : result.message ?? "上传失败");
    if (result.ok) { form.reset(); await load(); }
  }

  async function update(id: string, body: { status?: string; sortOrder?: number }) {
    const response = await fetch(`/api/admin/policies/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { message?: string };
    setMessage(response.ok ? "制度设置已更新" : result.message ?? "更新失败");
    if (response.ok) await load();
  }

  async function replace(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch(`/api/admin/policies/${id}`, { method: "POST", body: new FormData(form) });
    const result = await response.json() as { message?: string };
    setMessage(response.ok ? "新版本已上传，历史版本仍保留" : result.message ?? "版本替换失败");
    if (response.ok) { form.reset(); await load(); }
  }

  async function retryPreview(id: string) {
    setMessage("正在重新生成预览…");
    const response = await fetch(`/api/admin/policies/${id}/preview`, { method: "POST" });
    const result = await response.json() as { ok: boolean; message?: string; version?: { previewStatus?: string; previewError?: string } };
    setMessage(result.ok && result.version?.previewStatus === "READY"
      ? "预览已生成"
      : result.version?.previewError ?? result.message ?? "预览生成失败");
    await load();
  }

  function publishImpact(policy: Policy) {
    if (policy.status !== "PUBLISHED") return "删除后不影响员工端展示（当前未发布）。";
    if (policy.versions.length <= 1) return "删除当前发布版本后将自动下架，员工端不再展示。";
    return `删除当前发布版本后将回退到上一可用版本 v${policy.versions[1]?.versionNumber ?? "-"}。`;
  }

  async function confirmDelete(scope: "version" | "whole") {
    if (!deleteDialog) return;
    setBusy(true);
    try {
      const policy = deleteDialog.policy;
      const latest = policy.versions[0];
      const endpoint = scope === "version"
        ? `/api/admin/policies/${policy.id}/versions/${latest?.id}/recycle`
        : `/api/admin/policies/${policy.id}/recycle`;
      if (scope === "version" && !latest) {
        setMessage("没有可删除的版本");
        return;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as { ok?: boolean; message?: string; publishOutcome?: string };
      setMessage(response.ok
        ? (scope === "version"
          ? `当前版本已移入回收站${result.publishOutcome === "UNPUBLISHED" ? "，制度已下架" : result.publishOutcome === "ROLLED_BACK" ? "，已回退上一版本" : ""}`
          : "整份制度已移入回收站，员工端已下架")
        : result.message ?? "删除失败");
      if (response.ok) {
        setDeleteDialog(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function restoreWhole(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/policies/${id}/recycle/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as { message?: string };
      setMessage(response.ok ? "已从回收站恢复为未发布草稿" : result.message ?? "恢复失败");
      if (response.ok) {
        await loadRecycleBin();
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function permanentDelete(id: string) {
    if (!window.confirm("将永久删除该制度及其全部文件，且无法恢复。确认继续？")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/policies/${id}/recycle/permanent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result = await response.json() as { message?: string };
      setMessage(response.ok ? "已永久删除" : result.message ?? "永久删除失败");
      if (response.ok) await loadRecycleBin();
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(item: RecycledPolicyVersion) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/policies/${item.policy.id}/versions/${item.id}/recycle/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as { message?: string };
      setMessage(response.ok ? `制度版本 v${item.versionNumber} 已恢复` : result.message ?? "版本恢复失败");
      if (response.ok) {
        await loadRecycleBin();
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function permanentDeleteVersion(item: RecycledPolicyVersion) {
    if (!window.confirm(`将永久删除“${item.policy.name}”的版本 v${item.versionNumber} 及其文件，且无法恢复。确认继续？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/policies/${item.policy.id}/versions/${item.id}/recycle/permanent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result = await response.json() as { message?: string };
      setMessage(response.ok ? `制度版本 v${item.versionNumber} 已永久删除` : result.message ?? "版本永久删除失败");
      if (response.ok) await loadRecycleBin();
    } finally {
      setBusy(false);
    }
  }

  async function openRecycleBin() {
    setShowRecycleBin(true);
    await loadRecycleBin();
  }

  return <main className="admin-content">
    <header className="page-title-row">
      <div>
        <p className="eyebrow">POLICIES · 私有在线预览</p>
        <h1>制度管理</h1>
        <p>发布范围固定为全体在职员工；原文件与预览文件均保存在私有目录。</p>
      </div>
      <button type="button" onClick={() => void openRecycleBin()}>回收站</button>
    </header>
    {environment && <section className={`preview-environment ${environment.available && environment.chineseFontAvailable ? "ready" : "warning"}`} aria-label="预览转换环境">
      <strong>{environment.available ? "Office 转换器可用" : "Office 转换器不可用"}</strong>
      <span>{environment.chineseFontAvailable ? "中文字体可用" : "未检测到中文字体"}{environment.version ? ` · ${environment.version}` : ""}</span>
    </section>}
    <form className="policy-upload-form" onSubmit={submit}>
      <input name="name" placeholder="制度名称" required />
      <input name="category" placeholder="分类" required />
      <input name="versionNumber" placeholder="版本，如 1.0" required />
      <div className="date-input-wrap">
        <Calendar className="date-icon" aria-hidden="true" />
        <input name="effectiveDate" type="date" required />
      </div>
      <div className="policy-audience"><strong>发布范围</strong><span>全体在职员工</span></div>
      <FilePickerButton
        name="file"
        ariaLabel="制度上传文件"
        buttonText="选择文件"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt"
        required
      />
      <button className="primary-action" type="submit">上传为草稿</button>
    </form>
    <p className="status-message" role="status">{message}</p>
    <section className="admin-policy-list">
      {policies.map((policy) => {
        const latest = policy.versions[0];
        const previewLabel = latest?.previewStatus === "READY"
          ? `预览成功 · ${latest.previewFormat}`
          : latest?.previewStatus === "FAILED"
            ? `预览失败 · ${latest.previewError ?? "请重试"}`
            : latest?.previewStatus === "PROCESSING" ? "正在生成预览" : "等待生成预览";
        return <article key={policy.id}>
        <div className="policy-summary"><strong>{policy.name}</strong><span>{policy.category} · 当前 v{latest?.versionNumber ?? "-"} · 共 {policy.versions.length} 个版本</span><span className={`preview-status ${latest?.previewStatus?.toLowerCase() ?? "pending"}`}>{previewLabel}</span></div>
        <span className="tag">{policy.status}</span>
        <label className="policy-order">顺序<input type="number" min="0" defaultValue={policy.sortOrder} onBlur={(event) => void update(policy.id, { sortOrder: Number(event.target.value) })} /></label>
        <div className="policy-actions">
          {latest?.previewStatus === "READY" && <a href={`/api/admin/policies/${policy.id}/preview`} target="_blank" rel="noreferrer">预览</a>}
          {latest?.previewStatus !== "READY" && <button type="button" onClick={() => void retryPreview(policy.id)}>重新生成预览</button>}
          <button type="button" disabled={latest?.previewStatus !== "READY"} onClick={() => void update(policy.id, { status: "PUBLISHED" })}>发布</button>
          <button type="button" onClick={() => void update(policy.id, { status: "ARCHIVED" })}>归档</button>
          <button type="button" className="danger-action" onClick={() => setDeleteDialog({ policy, mode: "choose" })}>删除</button>
        </div>
        <form className="policy-replace-form" onSubmit={(event) => void replace(event, policy.id)}>
          <div className="replace-form-header">
            <strong>上传新版本</strong>
            <span className="version-hint">替换现有版本，历史记录将自动保留</span>
          </div>
          <div className="replace-form-grid">
            <label className="field-group">
              <span className="field-label">新版本号</span>
              <input name="versionNumber" aria-label={`${policy.name}新版本号`} placeholder="例如 1.1 或 2.0" required />
            </label>
            <label className="field-group">
              <span className="field-label"><Calendar className="w-3.5 h-3.5 inline-icon" aria-hidden="true" />生效日期</span>
              <div className="date-input-wrap">
                <Calendar className="date-icon" aria-hidden="true" />
                <input name="effectiveDate" aria-label={`${policy.name}新版本生效日期`} type="date" required />
              </div>
            </label>
            <div className="field-group file-field-group">
              <span className="field-label">选择文件</span>
              <FilePickerButton
                name="file"
                ariaLabel={`${policy.name}新版本文件`}
                buttonText="选择新版本文件"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt"
                required
              />
            </div>
          </div>
          <div className="replace-form-footer">
            <button type="submit" className="primary-action submit-replace-btn">
              <Upload className="w-4 h-4 inline-icon" aria-hidden="true" />
              <span>替换并保留历史</span>
            </button>
          </div>
        </form>
      </article>;})}
    </section>

    {deleteDialog && <dialog className="admin-dialog content-recycle-dialog danger-dialog" open role="dialog" aria-label="删除制度确认">
      <h2>删除制度</h2>
      <p><strong>资料名称：</strong>{deleteDialog.policy.name}</p>
      <p><strong>当前版本：</strong>v{deleteDialog.policy.versions[0]?.versionNumber ?? "-"}</p>
      <p><strong>历史版本数量：</strong>{Math.max(0, deleteDialog.policy.versions.length - 1)}</p>
      <p><strong>删除后的发布结果：</strong>{publishImpact(deleteDialog.policy)}</p>
      <p>删除后进入回收站，默认保留 30 天，可恢复或永久删除。此操作与“归档”不同。</p>
      <footer>
        <button type="button" disabled={busy} onClick={() => setDeleteDialog(null)}>取消</button>
        <button type="button" className="danger-action" disabled={busy || deleteDialog.policy.versions.length === 0} onClick={() => void confirmDelete("version")}>删除当前版本</button>
        <button type="button" className="danger-action" disabled={busy} onClick={() => void confirmDelete("whole")}>删除整份资料</button>
      </footer>
    </dialog>}

    {showRecycleBin && <dialog className="admin-dialog content-recycle-dialog" open role="dialog" aria-label="制度回收站">
      <h2>制度回收站</h2>
      <p>软删除内容默认保留 30 天。恢复后为未发布草稿，不会自动对员工可见。</p>
      <h3>整份制度</h3>
      <ul className="recycle-bin-list">
        {recyclePolicies.length === 0 && <li>回收站为空</li>}
        {recyclePolicies.map((item) => <li key={item.id}>
          <strong>{item.name}</strong>
          <span>{item.category} · 删除于 {item.deletedAt ? new Date(item.deletedAt).toLocaleString("zh-CN") : "-"}</span>
          <div>
            <button type="button" disabled={busy} onClick={() => void restoreWhole(item.id)}>恢复整份</button>
            <button type="button" className="danger-action" disabled={busy} onClick={() => void permanentDelete(item.id)}>永久删除</button>
          </div>
        </li>)}
      </ul>
      <h3>独立删除的版本</h3>
      <ul className="recycle-bin-list">
        {recycleVersions.length === 0 && <li>没有独立删除的版本</li>}
        {recycleVersions.map((item) => <li key={item.id}>
          <strong>{item.policy.name} · v{item.versionNumber}</strong>
          <span>{item.policy.category} · 删除于 {item.deletedAt ? new Date(item.deletedAt).toLocaleString("zh-CN") : "-"}</span>
          <div>
            <button type="button" disabled={busy} aria-label={`恢复版本 v${item.versionNumber}`} onClick={() => void restoreVersion(item)}>恢复版本</button>
            <button type="button" className="danger-action" disabled={busy} aria-label={`永久删除版本 v${item.versionNumber}`} onClick={() => void permanentDeleteVersion(item)}>永久删除</button>
          </div>
        </li>)}
      </ul>
      <footer>
        <button type="button" onClick={() => setShowRecycleBin(false)}>关闭</button>
      </footer>
    </dialog>}
  </main>;
}

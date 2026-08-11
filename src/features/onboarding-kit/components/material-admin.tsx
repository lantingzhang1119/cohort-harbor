"use client";

import { Archive, Download, FileClock, FileUp, PackageCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

type Version = { id: string; versionNumber: number; displayName: string; originalName: string; extension: string; mimeType: string; sizeBytes: number; createdAt: string };
type Material = { id: string; title: string; category: string; description: string | null; sortOrder: number; status: string; updatedAt: string; currentVersion: Version | null; versions: Version[] };
type RecycledMaterial = { id: string; title: string; category: string; deletedAt: string | null; statusBeforeDelete: string | null; versions: Version[] };
type RecycledMaterialVersion = Version & { deletedAt: string | null; material: { id: string; title: string; category: string; status: string } };

const statusLabels: Record<string, string> = { DRAFT: "草稿", PUBLISHED: "已发布", ARCHIVED: "已归档" };
const accepted = ".doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function MaterialAdmin() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [message, setMessage] = useState("正在加载资料…");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Material | null>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [recycleMaterials, setRecycleMaterials] = useState<RecycledMaterial[]>([]);
  const [recycleVersions, setRecycleVersions] = useState<RecycledMaterialVersion[]>([]);

  async function load(signal?: AbortSignal) {
    const response = await fetch("/api/admin/onboarding-kit", { signal });
    const result = await response.json() as { ok: boolean; materials?: Material[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "资料加载失败");
    setMaterials(result.materials ?? []);
    setMessage(result.materials?.length ? "" : "还没有入职资料，请先上传第一份资料。");
  }

  async function loadRecycleBin() {
    const response = await fetch("/api/admin/onboarding-kit/recycle-bin");
    const result = await response.json() as { ok: boolean; materials?: RecycledMaterial[]; versions?: RecycledMaterialVersion[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "回收站加载失败");
    setRecycleMaterials(result.materials ?? []);
    setRecycleVersions(result.versions ?? []);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/onboarding-kit", { signal: controller.signal })
      .then(async (response) => ({ response, result: await response.json() as { ok: boolean; materials?: Material[]; message?: string } }))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.message ?? "资料加载失败");
        setMaterials(result.materials ?? []);
        setMessage(result.materials?.length ? "" : "还没有入职资料，请先上传第一份资料。");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setMessage(error instanceof Error ? error.message : "资料加载失败");
      });
    return () => controller.abort();
  }, []);

  async function submitForm(endpoint: string, method: string, body?: BodyInit, success = "操作已完成") {
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method, body, headers: body instanceof FormData ? undefined : { "content-type": "application/json" } });
      const result = await response.json() as { ok: boolean; message?: string };
      if (!response.ok) throw new Error(result.message ?? "操作失败");
      await load();
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败，请稍后重试");
      return false;
    } finally { setBusy(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await submitForm("/api/admin/onboarding-kit", "POST", new FormData(form), "资料草稿已创建")) form.reset();
  }

  async function update(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await submitForm(`/api/admin/onboarding-kit/${id}`, "PATCH", JSON.stringify({
      title: data.get("title"), category: data.get("category"), description: data.get("description") || null, sortOrder: Number(data.get("sortOrder") ?? 0),
    }), "资料信息已更新，文件版本未改变");
  }

  async function replace(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await submitForm(`/api/admin/onboarding-kit/${id}/file`, "POST", new FormData(form), "新文件版本已保存，历史版本仍可下载")) form.reset();
  }

  function publishImpact(material: Material) {
    if (material.status !== "PUBLISHED") return "删除后不影响员工端展示（当前未发布）。";
    if ((material.versions?.length ?? 0) <= 1) return "删除当前发布版本后将自动下架，员工端不再展示。";
    const previous = material.versions.find((version) => version.id !== material.currentVersion?.id);
    return previous
      ? `删除当前发布版本后将回退到上一可用版本 v${previous.versionNumber}。`
      : "删除当前发布版本后将自动下架，员工端不再展示。";
  }

  async function confirmDelete(scope: "version" | "whole") {
    if (!deleteTarget) return;
    const current = deleteTarget.currentVersion ?? deleteTarget.versions[0];
    const endpoint = scope === "version"
      ? `/api/admin/onboarding-kit/${deleteTarget.id}/versions/${current?.id}/recycle`
      : `/api/admin/onboarding-kit/${deleteTarget.id}/recycle`;
    if (scope === "version" && !current) {
      setMessage("没有可删除的版本");
      return;
    }
    const ok = await submitForm(
      endpoint,
      "POST",
      JSON.stringify({}),
      scope === "version" ? "当前版本已移入回收站" : "整份资料已移入回收站，员工端已下架",
    );
    if (ok) setDeleteTarget(null);
  }

  async function restoreWhole(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/onboarding-kit/${id}/recycle/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "恢复失败");
      await loadRecycleBin();
      await load();
      setMessage("已从回收站恢复为未发布草稿");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }

  async function permanentDelete(id: string) {
    if (!window.confirm("将永久删除该资料及其全部文件，且无法恢复。确认继续？")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/onboarding-kit/${id}/recycle/permanent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "永久删除失败");
      await loadRecycleBin();
      setMessage("已永久删除");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "永久删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(item: RecycledMaterialVersion) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/onboarding-kit/${item.material.id}/versions/${item.id}/recycle/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "版本恢复失败");
      await loadRecycleBin();
      await load();
      setMessage(`资料版本 v${item.versionNumber} 已恢复`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "版本恢复失败");
    } finally {
      setBusy(false);
    }
  }

  async function permanentDeleteVersion(item: RecycledMaterialVersion) {
    if (!window.confirm(`将永久删除“${item.material.title}”的版本 v${item.versionNumber} 及其文件，且无法恢复。确认继续？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/onboarding-kit/${item.material.id}/versions/${item.id}/recycle/permanent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "版本永久删除失败");
      await loadRecycleBin();
      setMessage(`资料版本 v${item.versionNumber} 已永久删除`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "版本永久删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function openRecycleBin() {
    setShowRecycleBin(true);
    try {
      await loadRecycleBin();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回收站加载失败");
    }
  }

  return <main className="admin-content onboarding-admin-page">
    <header className="page-title-row">
      <div>
        <p className="eyebrow">ONBOARDING KIT · 入职资料</p>
        <h1>入职资料包</h1>
        <p>管理员和超级管理员可上传、修改、下载与发布资料；替换文件会保留完整版本历史。</p>
      </div>
      <button type="button" onClick={() => void openRecycleBin()}>回收站</button>
    </header>
    <section className="onboarding-upload-card">
      <header><span><Upload aria-hidden="true" /></span><div><h2>上传新资料</h2><p>支持 Word、Excel、PPT、PDF、图片、CSV 与 TXT，单文件默认不超过 50 MiB。</p></div></header>
      <form onSubmit={(event) => void create(event)}>
        <label><span>资料名称</span><input name="title" required maxLength={120} placeholder="例如：新员工第一天手册" /></label>
        <label><span>分类</span><input name="category" required maxLength={80} placeholder="例如：入职必读" /></label>
        <label><span>显示顺序</span><input name="sortOrder" type="number" defaultValue="0" /></label>
        <label className="wide"><span>说明</span><textarea name="description" maxLength={2000} placeholder="可选：告诉员工何时使用这份资料" /></label>
        <label className="file-drop wide"><FileUp aria-hidden="true" /><span>选择资料文件</span><input name="file" type="file" accept={accepted} required /></label>
        <button className="primary-action" type="submit" disabled={busy}>上传为草稿</button>
      </form>
    </section>
    <p className="status-message" role="status">{message}</p>
    <section className="onboarding-admin-list" aria-label="入职资料列表">
      {materials.map((material) => <article key={material.id}>
        <header>
          <span className={`material-status ${material.status.toLowerCase()}`}>{statusLabels[material.status] ?? material.status}</span>
          <div><p>{material.category}</p><h2>{material.title}</h2><small>{material.description || "暂无说明"}</small></div>
          <div className="material-lifecycle">
            <button type="button" disabled={busy || material.status === "PUBLISHED"} onClick={() => void submitForm(`/api/admin/onboarding-kit/${material.id}/publish`, "POST", undefined, "资料已发布到员工端")}><PackageCheck aria-hidden="true" />发布</button>
            <button type="button" disabled={busy || material.status === "ARCHIVED"} onClick={() => void submitForm(`/api/admin/onboarding-kit/${material.id}/archive`, "POST", undefined, "资料已归档，员工端不再可见")}><Archive aria-hidden="true" />归档</button>
            <button type="button" className="danger-action" disabled={busy} onClick={() => setDeleteTarget(material)}><Trash2 aria-hidden="true" />删除</button>
          </div>
        </header>
        <div className="material-current"><strong>当前 v{material.currentVersion?.versionNumber ?? "-"}</strong><span>{material.currentVersion?.displayName ?? "暂无文件"}</span><small>{material.currentVersion ? formatBytes(material.currentVersion.sizeBytes) : ""}</small></div>
        <div className="material-admin-actions">
          <details><summary>修改资料信息</summary><form onSubmit={(event) => void update(event, material.id)}>
            <label>资料名称<input name="title" required defaultValue={material.title} /></label>
            <label>分类<input name="category" required defaultValue={material.category} /></label>
            <label>显示顺序<input name="sortOrder" type="number" defaultValue={material.sortOrder} /></label>
            <label className="wide">说明<textarea name="description" defaultValue={material.description ?? ""} /></label>
            <button type="submit" disabled={busy}>保存资料信息</button>
          </form></details>
          <details><summary>替换文件（新增版本）</summary><form onSubmit={(event) => void replace(event, material.id)}>
            <label className="wide">新版本文件<input name="file" type="file" accept={accepted} required /></label>
            <p>保存后生成 v{(material.currentVersion?.versionNumber ?? 0) + 1}，不会覆盖历史文件。</p>
            <button type="submit" disabled={busy}>上传新版本</button>
          </form></details>
          <details><summary>版本历史</summary><ol className="material-version-list">
            {material.versions.map((version) => <li key={version.id}><FileClock aria-hidden="true" /><span><strong>v{version.versionNumber} · {version.displayName}</strong><small>{formatBytes(version.sizeBytes)} · {new Date(version.createdAt).toLocaleDateString("zh-CN")}</small></span><a href={`/api/admin/onboarding-kit/${material.id}/file?versionId=${encodeURIComponent(version.id)}`}><Download aria-hidden="true" />下载 v{version.versionNumber}</a></li>)}
          </ol></details>
        </div>
      </article>)}
    </section>

    {deleteTarget && <dialog className="admin-dialog content-recycle-dialog danger-dialog" open role="dialog" aria-label="删除资料确认">
      <h2>删除入职资料</h2>
      <p><strong>资料名称：</strong>{deleteTarget.title}</p>
      <p><strong>当前版本：</strong>v{deleteTarget.currentVersion?.versionNumber ?? "-"}</p>
      <p><strong>历史版本数量：</strong>{Math.max(0, deleteTarget.versions.length - 1)}</p>
      <p><strong>删除后的发布结果：</strong>{publishImpact(deleteTarget)}</p>
      <p>删除后进入回收站，默认保留 30 天。此操作与“归档”不同。</p>
      <footer>
        <button type="button" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button>
        <button type="button" className="danger-action" disabled={busy || !deleteTarget.currentVersion} onClick={() => void confirmDelete("version")}>删除当前版本</button>
        <button type="button" className="danger-action" disabled={busy} onClick={() => void confirmDelete("whole")}>删除整份资料</button>
      </footer>
    </dialog>}

    {showRecycleBin && <dialog className="admin-dialog content-recycle-dialog" open role="dialog" aria-label="入职资料回收站">
      <h2>入职资料回收站</h2>
      <p>软删除内容默认保留 30 天。恢复后为未发布草稿，不会自动对员工可见。</p>
      <h3>整份资料</h3>
      <ul className="recycle-bin-list">
        {recycleMaterials.length === 0 && <li>回收站为空</li>}
        {recycleMaterials.map((item) => <li key={item.id}>
          <strong>{item.title}</strong>
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
          <strong>{item.material.title} · v{item.versionNumber}</strong>
          <span>{item.displayName} · 删除于 {item.deletedAt ? new Date(item.deletedAt).toLocaleString("zh-CN") : "-"}</span>
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

"use client";

import { useEffect, useState, type FormEvent } from "react";

type Chapter = { id: string; title: string; body: string | null; address: string | null; contact: string | null; externalUrl: string | null; sortOrder: number; enabled: boolean; imageAsset: { id: string; originalName: string; mimeType: string } | null };
type Guide = { id: string; city: string; title: string; summary: string | null; enabled: boolean; chapters: Chapter[]; revisions: Array<{ id: string; summary: string; createdAt: string }> };

const cities = ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"];
const cityLabels: Record<string, string> = { SHANGHAI: "上海", SHENZHEN: "深圳", CHANGSHA: "长沙", XIAN: "西安" };

export function GuideAdmin() {
  const [guides, setGuides] = useState<Guide[]>([]);
  const [message, setMessage] = useState("正在加载指南与章节…");

  async function load() {
    const results = await Promise.all(cities.map((city) => fetch(`/api/admin/guides/${city}`).then((response) => response.json()) as Promise<{ guide?: Guide }>));
    setGuides(results.flatMap((result) => result.guide ? [result.guide] : []));
    setMessage("");
  }
  useEffect(() => { void Promise.all(cities.map((city) => fetch(`/api/admin/guides/${city}`).then((response) => response.json()) as Promise<{ guide?: Guide }>)).then((results) => { setGuides(results.flatMap((result) => result.guide ? [result.guide] : [])); setMessage(""); }).catch(() => setMessage("指南加载失败")); }, []);

  function updateGuideState(id: string, patch: Partial<Guide>) {
    setGuides((current) => current.map((guide) => guide.id === id ? { ...guide, ...patch } : guide));
  }
  function updateChapter(guideId: string, chapterId: string, patch: Partial<Chapter>) {
    setGuides((current) => current.map((guide) => guide.id === guideId ? { ...guide, chapters: guide.chapters.map((chapter) => chapter.id === chapterId ? { ...chapter, ...patch } : chapter) } : guide));
  }
  async function saveGuide(guide: Guide) {
    const response = await fetch(`/api/admin/guides/${guide.city}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: guide.title, summary: guide.summary, enabled: guide.enabled }) });
    setMessage(response.ok ? `${cityLabels[guide.city]}指南基本信息已保存` : "保存失败");
    if (response.ok) await load();
  }
  async function addChapter(guide: Guide) {
    const response = await fetch(`/api/admin/guides/${guide.city}/chapters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新章节", body: null, address: null, contact: null, externalUrl: null, sortOrder: guide.chapters.length + 1, enabled: true }) });
    setMessage(response.ok ? "新章节已创建，请继续编辑" : "章节创建失败");
    if (response.ok) await load();
  }
  async function saveChapter(event: FormEvent<HTMLFormElement>, guide: Guide, chapter: Chapter) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch(`/api/admin/guides/${guide.city}/chapters/${chapter.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: chapter.title, body: chapter.body, address: chapter.address, contact: chapter.contact, externalUrl: chapter.externalUrl, sortOrder: chapter.sortOrder, enabled: chapter.enabled }) });
    if (!response.ok) { setMessage("章节保存失败"); return; }
    const image = new FormData(form).get("file");
    if (image instanceof File && image.size > 0) {
      const upload = new FormData(); upload.set("file", image); upload.set("kind", String(new FormData(form).get("kind") ?? "IMAGE"));
      const imageResponse = await fetch(`/api/admin/guides/${guide.city}/chapters/${chapter.id}/image`, { method: "POST", body: upload });
      if (!imageResponse.ok) { setMessage("文字已保存，但图片上传失败，请检查格式和大小"); return; }
    }
    setMessage(`章节“${chapter.title}”已保存并记录修订`);
    form.reset();
    await load();
  }
  async function removeChapter(guide: Guide, chapter: Chapter) {
    if (!window.confirm(`确认删除章节“${chapter.title}”？`)) return;
    const response = await fetch(`/api/admin/guides/${guide.city}/chapters/${chapter.id}`, { method: "DELETE" });
    setMessage(response.ok ? "章节已删除并保留修订记录" : "删除失败");
    if (response.ok) await load();
  }
  async function moveChapter(guide: Guide, index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= guide.chapters.length) return;
    const ids = guide.chapters.map((chapter) => chapter.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    const response = await fetch(`/api/admin/guides/${guide.city}/chapters/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapterIds: ids }) });
    setMessage(response.ok ? "章节顺序已调整" : "排序失败");
    if (response.ok) await load();
  }

  return <main className="admin-content"><header className="page-title-row"><div><p className="eyebrow">GUIDES · 四地内容</p><h1>入职指南管理</h1><p>编辑章节文字、联系人、地址、图片/座位图、外部链接、启用状态和显示顺序；每次修改保留修订记录。</p></div></header><p className="status-message" role="status">{message}</p><section className="guide-admin-stack">{guides.map((guide) => <article className="guide-editor" key={guide.id}><header><div><span>{cityLabels[guide.city]}</span><input aria-label={`${cityLabels[guide.city]}指南标题`} value={guide.title} onChange={(event) => updateGuideState(guide.id, { title: event.target.value })} /></div><label><input type="checkbox" checked={guide.enabled} onChange={(event) => updateGuideState(guide.id, { enabled: event.target.checked })} />员工端启用</label></header><textarea aria-label={`${cityLabels[guide.city]}指南摘要`} value={guide.summary ?? ""} onChange={(event) => updateGuideState(guide.id, { summary: event.target.value })} placeholder="城市指南摘要" /><div className="guide-editor-actions"><button type="button" onClick={() => void saveGuide(guide)}>保存指南信息</button><button type="button" onClick={() => void addChapter(guide)}>＋ 新增章节</button><small>最近修订：{guide.revisions[0]?.summary ?? "暂无"}</small></div><section className="chapter-admin-list">{guide.chapters.map((chapter, index) => <form key={chapter.id} onSubmit={(event) => void saveChapter(event, guide, chapter)}><header><strong>{String(index + 1).padStart(2, "0")}</strong><input aria-label="章节标题" value={chapter.title} onChange={(event) => updateChapter(guide.id, chapter.id, { title: event.target.value })} /><label><input type="checkbox" checked={chapter.enabled} onChange={(event) => updateChapter(guide.id, chapter.id, { enabled: event.target.checked })} />启用</label></header><textarea aria-label="章节正文" value={chapter.body ?? ""} onChange={(event) => updateChapter(guide.id, chapter.id, { body: event.target.value })} placeholder="章节正文（可留空，保留源页图片）" /><div className="chapter-fields"><input aria-label="地址" value={chapter.address ?? ""} onChange={(event) => updateChapter(guide.id, chapter.id, { address: event.target.value })} placeholder="地址" /><input aria-label="联系人" value={chapter.contact ?? ""} onChange={(event) => updateChapter(guide.id, chapter.id, { contact: event.target.value })} placeholder="联系人" /><input aria-label="外部链接" value={chapter.externalUrl ?? ""} onChange={(event) => updateChapter(guide.id, chapter.id, { externalUrl: event.target.value })} placeholder="https://..." /><input aria-label="显示顺序" type="number" min="0" value={chapter.sortOrder} onChange={(event) => updateChapter(guide.id, chapter.id, { sortOrder: Number(event.target.value) })} /></div>{chapter.imageAsset && <a className="chapter-image-link" href={`/api/files/${chapter.imageAsset.id}`} target="_blank" rel="noreferrer">当前图片：{chapter.imageAsset.originalName}</a>}<div className="chapter-upload"><input name="file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" /><select name="kind" defaultValue="IMAGE"><option value="IMAGE">内容图片</option><option value="MAP">座位图 / 地图</option></select></div><footer><button type="button" onClick={() => void moveChapter(guide, index, -1)} disabled={index === 0}>上移</button><button type="button" onClick={() => void moveChapter(guide, index, 1)} disabled={index === guide.chapters.length - 1}>下移</button><button className="danger-action" type="button" onClick={() => void removeChapter(guide, chapter)}>删除</button><button className="primary-action" type="submit">保存章节</button></footer></form>)}</section></article>)}</section></main>;
}

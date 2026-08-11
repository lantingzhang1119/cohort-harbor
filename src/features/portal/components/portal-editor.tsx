"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { PortalViewport } from "@/generated/prisma/enums";
import { PortalCanvas, type PortalCanvasElement } from "@/features/portal/components/portal-canvas";
import { PortalViewer } from "@/features/portal/components/portal-viewer";
import { PORTAL_CANVAS_SIZES, PORTAL_MIN_ELEMENT_SIZE } from "@/features/portal/portal-schemas";

const cities = ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"] as const;
type PortalCity = typeof cities[number];
type LoadState = "loading" | "ready" | "error";
type Asset = { id: string; originalName: string; mimeType: string; sizeBytes: number; url: string };
type DraftResponse = { ok: boolean; draft: { elements: PortalCanvasElement[] } | null; message?: string };

const cityLabels: Record<PortalCity, string> = { SHANGHAI: "上海", SHENZHEN: "深圳", CHANGSHA: "长沙", XIAN: "西安" };
const viewportLabels = { DESKTOP: "桌面 1440×900", MOBILE: "手机 390×844" } as const;
const contextKey = (city: PortalCity, viewport: PortalViewport) => `${city}:${viewport}`;
const clampZIndex = (value: number) => Math.min(10_000, Math.max(-10_000, Math.round(value)));

function serializeElement(element: PortalCanvasElement) {
  return { id: element.id, kind: element.kind, assetId: element.assetId, x: element.x, y: element.y, width: element.width, height: element.height, zIndex: element.zIndex, altText: element.altText };
}

function mergeAssets(current: Asset[], incoming: Asset[]) {
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) byId.set(asset.id, asset);
  return [...byId.values()];
}

export function PortalEditor() {
  const [city, setCity] = useState<PortalCity>("SHANGHAI");
  const [viewport, setViewport] = useState<PortalViewport>(PortalViewport.DESKTOP);
  const [elements, setElements] = useState<PortalCanvasElement[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replacementAssetId, setReplacementAssetId] = useState("");
  const [message, setMessage] = useState("正在加载门户草稿…");
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const logoInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const mutationInFlight = useRef(false);
  const activeContext = useRef({ city, viewport });
  const loadStateRef = useRef<LoadState>("loading");
  const skipLoadKey = useRef<string | null>(null);
  const currentSelection = useMemo(() => elements.find((element) => element.id === selectedId) ?? null, [elements, selectedId]);

  useEffect(() => {
    const key = contextKey(city, viewport);
    if (skipLoadKey.current === key) { skipLoadKey.current = null; return; }
    const sequence = ++loadSequence.current;
    loadStateRef.current = "loading";
    setLoadState("loading");
    setElements([]);
    setSelectedId(null);
    setPreview(false);
    setMessage("正在加载门户草稿…");
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/admin/portal/${city}/draft?viewport=${viewport}`, { signal: controller.signal }),
      fetch(`/api/admin/portal/${city}/assets`, { signal: controller.signal }),
    ]).then(async ([draftResponse, assetResponse]) => {
      const draftResult = await draftResponse.json() as DraftResponse;
      const assetResult = await assetResponse.json() as { ok: boolean; assets?: Asset[]; message?: string };
      if (sequence !== loadSequence.current || contextKey(activeContext.current.city, activeContext.current.viewport) !== key) return;
      if (!draftResponse.ok || !assetResponse.ok) throw new Error(draftResult.message ?? assetResult.message ?? "门户草稿加载失败");
      setElements(draftResult.draft?.elements ?? []);
      setAssets((current) => mergeAssets(current, assetResult.assets ?? []));
      setDirty(false);
      loadStateRef.current = "ready";
      setLoadState("ready");
      setMessage(draftResult.draft ? "" : `${cityLabels[city]}${viewport === "DESKTOP" ? "桌面" : "手机"}尚无草稿`);
    }).catch((error) => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      setElements([]);
      setSelectedId(null);
      setDirty(false);
      loadStateRef.current = "error";
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "门户草稿加载失败");
    });
    return () => controller.abort();
  }, [city, viewport]);

  function changeContext(nextCity: PortalCity, nextViewport: PortalViewport) {
    if (nextCity === city && nextViewport === viewport) return;
    if (dirty && !window.confirm("当前画布有未保存修改，是否放弃并切换？")) return;
    activeContext.current = { city: nextCity, viewport: nextViewport };
    loadStateRef.current = "loading";
    setDirty(false);
    setLoadState("loading");
    setElements([]);
    setSelectedId(null);
    setCity(nextCity);
    setViewport(nextViewport);
  }

  async function mutate<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (mutationInFlight.current) { setMessage("请等待当前操作完成"); return; }
    mutationInFlight.current = true;
    setBusy(label);
    try { return await operation(); }
    catch (error) { setMessage(error instanceof Error ? error.message : `${label}失败`); }
    finally { mutationInFlight.current = false; setBusy(null); }
  }

  function replaceElements(next: PortalCanvasElement[]) { setElements(next); setDirty(true); }

  function updateSelected(patch: Partial<PortalCanvasElement>) {
    if (!selectedId) return;
    const size = PORTAL_CANVAS_SIZES[viewport];
    replaceElements(elements.map((element) => {
      if (element.id !== selectedId) return element;
      const next = { ...element, ...patch };
      next.width = Math.min(size.canvasWidth, Math.max(PORTAL_MIN_ELEMENT_SIZE, Math.round(next.width)));
      next.height = Math.min(size.canvasHeight, Math.max(PORTAL_MIN_ELEMENT_SIZE, Math.round(next.height)));
      next.x = Math.min(size.canvasWidth - next.width, Math.max(0, Math.round(next.x)));
      next.y = Math.min(size.canvasHeight - next.height, Math.max(0, Math.round(next.y)));
      return next;
    }));
  }

  async function upload(kind: "LOGO" | "IMAGE") {
    const input = kind === "LOGO" ? logoInput.current : imageInput.current;
    const file = input?.files?.[0];
    if (!file) { setMessage(`请选择要上传的${kind === "LOGO" ? " Logo" : "素材"}`); return; }
    const requested = { ...activeContext.current };
    await mutate("上传", async () => {
      const form = new FormData(); form.set("file", file);
      const response = await fetch(`/api/admin/portal/${requested.city}/assets`, { method: "POST", body: form });
      const result = await response.json() as { asset?: Asset; message?: string };
      if (!response.ok || !result.asset) throw new Error(result.message ?? "素材上传失败");
      const asset = result.asset;
      setAssets((current) => mergeAssets(current, [asset]));
      const stillCoherent = contextKey(activeContext.current.city, activeContext.current.viewport) === contextKey(requested.city, requested.viewport) && loadStateRef.current === "ready";
      if (stillCoherent) {
        const next: PortalCanvasElement = {
          id: crypto.randomUUID(), kind, assetId: asset.id, assetUrl: asset.url, x: 20, y: 20,
          width: kind === "LOGO" ? 240 : 360, height: kind === "LOGO" ? 96 : 240,
          zIndex: clampZIndex(Math.max(0, ...elements.map((element) => element.zIndex)) + 1),
          altText: kind === "LOGO" ? `${cityLabels[requested.city]}品牌 Logo` : asset.originalName,
        };
        setElements((current) => [...current, next]);
        setSelectedId(next.id);
        setDirty(true);
        setMessage(`${kind === "LOGO" ? "Logo" : "素材"} 已加入${requested.viewport === "DESKTOP" ? "桌面" : "手机"}布局`);
      } else {
        setMessage("素材已上传到全城共用素材库；因已切换画布，未自动添加元素");
      }
      if (input) input.value = "";
    });
  }

  async function saveDraft() {
    if (loadState !== "ready") return;
    await mutate("保存草稿", async () => {
      const response = await fetch(`/api/admin/portal/${city}/draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport, elements: elements.map(serializeElement) }) });
      const result = await response.json() as DraftResponse;
      if (!response.ok || !result.draft) throw new Error(result.message ?? "草稿保存失败");
      setElements(result.draft.elements); setDirty(false); setMessage(`${viewport === "DESKTOP" ? "桌面" : "手机"}草稿已保存`);
    });
  }

  async function copyDesktop() {
    if (loadState !== "ready") return;
    if (dirty) { setMessage(viewport === "DESKTOP" ? "当前桌面画布未保存，无法复制，请先保存草稿" : "当前手机画布未保存，复制会覆盖修改，请先保存或放弃修改"); return; }
    await mutate("复制布局", async () => {
      const response = await fetch(`/api/admin/portal/${city}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "COPY_DESKTOP_TO_MOBILE" }) });
      const result = await response.json() as DraftResponse;
      if (!response.ok || !result.draft) throw new Error(result.message ?? "复制失败");
      activeContext.current = { city, viewport: PortalViewport.MOBILE };
      skipLoadKey.current = contextKey(city, PortalViewport.MOBILE);
      setViewport(PortalViewport.MOBILE); setElements(result.draft.elements); setSelectedId(null); setDirty(false);
      loadStateRef.current = "ready"; setLoadState("ready"); setMessage("已复制并约束到手机画布");
    });
  }

  async function publish() {
    if (loadState !== "ready") return;
    if (dirty) { setMessage("当前画布未保存，无法发布，请先保存草稿"); return; }
    const confirmed = window.confirm(`即将发布${cityLabels[city]}的桌面（1440×900）和手机（390×844）最后保存的草稿。确认同时发布两个视口？`);
    if (!confirmed) { setMessage("已取消发布；桌面和手机草稿均未发布"); return; }
    await mutate("发布", async () => {
      const response = await fetch(`/api/admin/portal/${city}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json() as { version?: number; message?: string };
      if (!response.ok || !result.version) throw new Error(result.message ?? "发布失败");
      setMessage(`${cityLabels[city]}门户版本 ${result.version} 已发布`);
    });
  }

  async function restore() {
    if (loadState !== "ready") return;
    if (dirty) { setMessage("当前画布未保存，无法恢复版本，请先保存或放弃修改"); return; }
    await mutate("恢复版本", async () => {
      const response = await fetch(`/api/admin/portal/${city}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport }) });
      const result = await response.json() as DraftResponse;
      if (!response.ok || !result.draft) throw new Error(result.message ?? "恢复失败");
      setElements(result.draft.elements); setSelectedId(null); setDirty(false); setMessage("上一发布版本已恢复为新草稿");
    });
  }

  function moveLayer(mode: "forward" | "back" | "top" | "bottom") {
    if (!currentSelection) return;
    const values = elements.map((element) => element.zIndex);
    const min = Math.min(0, ...values); const max = Math.max(0, ...values);
    updateSelected({ zIndex: clampZIndex(mode === "top" ? max + 1 : mode === "bottom" ? min - 1 : currentSelection.zIndex + (mode === "forward" ? 1 : -1)) });
  }

  function replaceAsset() {
    const asset = assets.find((item) => item.id === replacementAssetId);
    if (!asset || !currentSelection) { setMessage("请选择元素和替换素材"); return; }
    updateSelected({ assetId: asset.id, assetUrl: asset.url });
    setMessage("元素素材已替换；替代文字已保留，保存草稿后生效");
  }

  async function deleteUnusedAsset() {
    if (!replacementAssetId) { setMessage("请选择要删除的素材"); return; }
    if (elements.some((element) => element.assetId === replacementAssetId)) { setMessage("当前画布仍引用该素材，请先删除或替换元素并保存草稿"); return; }
    await mutate("删除素材", async () => {
      const response = await fetch(`/api/admin/portal/${city}/assets?assetId=${encodeURIComponent(replacementAssetId)}`, { method: "DELETE" });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "素材删除失败");
      setAssets((current) => current.filter((asset) => asset.id !== replacementAssetId));
      setReplacementAssetId(""); setMessage("未引用素材已删除");
    });
  }

  const editorDisabled = busy !== null || loadState !== "ready";
  const navigationDisabled = busy !== null && busy !== "上传";
  const previewPortal = { version: null, ...PORTAL_CANVAS_SIZES[viewport], elements };

  return <section className="portal-editor-panel" aria-busy={busy !== null}>
    <header className="page-title-row"><div><p className="eyebrow">PORTAL · 安全图片布局</p><h1>四城门户编辑器</h1><p>每个城市分别维护桌面与手机草稿；只有发布版本会展示给员工。</p></div></header>
    <div className="portal-tabs" role="tablist" aria-label="城市">{cities.map((item) => <button key={item} role="tab" aria-selected={city === item} disabled={navigationDisabled} onClick={() => changeContext(item, viewport)}>{cityLabels[item]}</button>)}</div>
    <div className="portal-tabs" role="tablist" aria-label="画布">{Object.values(PortalViewport).map((item) => <button key={item} role="tab" aria-selected={viewport === item} disabled={navigationDisabled} onClick={() => changeContext(city, item)}>{viewportLabels[item]}</button>)}</div>
    <p className="portal-breakpoint-note">员工端宽度不超过 760px 使用 390×844 手机发布版，其余使用 1440×900 桌面发布版。</p>
    <div className="portal-editor-grid">
      <div>
        {preview ? <div className={`portal-device-preview portal-device-preview--${viewport.toLowerCase()}`}><PortalViewer portal={previewPortal} /></div> : <PortalCanvas viewport={viewport} elements={elements} selectedId={selectedId} onSelect={(id) => setSelectedId(id || null)} onChange={replaceElements} />}
        <p className="status-message" role="status">{busy && message !== "请等待当前操作完成" ? `${busy}中…` : message}</p>
      </div>
      {!preview && <aside className="portal-editor-tools">
        <fieldset disabled={editorDisabled}><legend>素材 · <span>全城共用素材库</span></legend>
          <input ref={logoInput} aria-label="上传 Logo 文件" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" /><button type="button" onClick={() => void upload("LOGO")}>上传 Logo</button>
          <input ref={imageInput} aria-label="上传素材文件" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" /><button type="button" onClick={() => void upload("IMAGE")}>上传素材</button>
          <select aria-label="素材库" value={replacementAssetId} onChange={(event) => setReplacementAssetId(event.target.value)}><option value="">选择素材</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select>
          <button type="button" onClick={replaceAsset}>替换素材</button><button type="button" onClick={() => void deleteUnusedAsset()}>删除未引用素材</button>
        </fieldset>
        <fieldset disabled={editorDisabled || !currentSelection}><legend>元素</legend>
          <div className="portal-layer-actions"><button type="button" onClick={() => moveLayer("forward")}>前移</button><button type="button" onClick={() => moveLayer("back")}>后移</button><button type="button" onClick={() => moveLayer("top")}>置顶</button><button type="button" onClick={() => moveLayer("bottom")}>置底</button></div>
          {(["x", "y", "width", "height"] as const).map((field) => { const label = field === "x" ? "X 坐标" : field === "y" ? "Y 坐标" : field === "width" ? "宽度" : "高度"; return <label key={field}>{label}<input aria-label={label} type="number" min={field === "width" || field === "height" ? 24 : 0} value={currentSelection?.[field] ?? 0} onChange={(event) => updateSelected({ [field]: Number(event.target.value) })} /></label>; })}
          <label>替代文字<input aria-label="替代文字" value={currentSelection?.altText ?? ""} onChange={(event) => updateSelected({ altText: event.target.value })} /></label>
          <button type="button" className="danger-action" onClick={() => { replaceElements(elements.filter((element) => element.id !== selectedId)); setSelectedId(null); }}>删除元素</button>
        </fieldset>
        <div className="portal-publish-actions"><button type="button" disabled={editorDisabled} onClick={() => void copyDesktop()}>复制桌面到手机</button><button type="button" disabled={editorDisabled} onClick={() => setPreview(true)}>员工预览</button><button type="button" disabled={editorDisabled} onClick={() => void saveDraft()}>保存草稿</button><button type="button" disabled={editorDisabled} onClick={() => void publish()}>发布</button><button type="button" disabled={editorDisabled} onClick={() => void restore()}>恢复上一版本</button></div>
      </aside>}
      {preview && <aside className="portal-editor-tools"><button type="button" onClick={() => setPreview(false)}>退出员工预览</button></aside>}
    </div>
  </section>;
}

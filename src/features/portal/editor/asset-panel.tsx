"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import Image from "next/image";

export type PortalAssetReference = {
  city: string;
  viewport: "DESKTOP" | "MOBILE";
  version?: number;
  elementId: string;
};

export type PortalAsset = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  category: string;
  width: number | null;
  height: number | null;
  inspectionStatus: string;
  searchText: string;
  references: {
    draft: PortalAssetReference[];
    current: PortalAssetReference[];
    history: PortalAssetReference[];
  };
  referenceCounts: { draft: number; current: number; history: number };
  unused: boolean;
  url: string;
};

const CITY_NAMES: Record<string, string> = {
  SHANGHAI: "上海",
  SHENZHEN: "深圳",
  CHANGSHA: "长沙",
  XIAN: "西安",
};

function referenceLabel(
  reference: PortalAssetReference,
  kind: "草稿" | "当前发布" | "历史发布",
) {
  const city = CITY_NAMES[reference.city] ?? reference.city;
  const viewport = reference.viewport === "MOBILE" ? "手机" : "桌面";
  const version = reference.version === undefined ? "" : ` · v${reference.version}`;
  const target = reference.elementId === "__background__" ? "背景" : reference.elementId;
  return `${city} · ${viewport} · ${kind}${version} · ${target}`;
}

export function AssetPanel({
  assets,
  loading,
  uploading,
  selectedElementIsImage,
  selectedAssetId,
  onSelectedAssetId,
  onChoose,
  onUpload,
  onDelete,
}: {
  assets: PortalAsset[];
  loading: boolean;
  uploading: boolean;
  selectedElementIsImage: boolean;
  selectedAssetId: string | null;
  onSelectedAssetId(id: string): void;
  onChoose(asset: PortalAsset): void;
  onUpload(file: File, category: "LOGO" | "IMAGE"): void;
  onDelete(asset: PortalAsset): void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [uploadCategory, setUploadCategory] = useState<"LOGO" | "IMAGE">("IMAGE");
  const filtered = useMemo(() => assets.filter((asset) => {
    const matchesQuery = `${asset.searchText} ${asset.originalName}`.toLocaleLowerCase("zh-CN")
      .includes(query.trim().toLocaleLowerCase("zh-CN"));
    return matchesQuery && (category === "ALL" || asset.category === category);
  }), [assets, category, query]);

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUpload(file, uploadCategory);
    event.target.value = "";
  };

  return (
    <section aria-label="素材库面板">
      <h2>素材库</h2>
      <label>
        搜索素材
        <input
          type="search"
          aria-label="搜索素材"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label>
        素材分类
        <select aria-label="素材分类" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="ALL">全部</option>
          <option value="LOGO">Logo</option>
          <option value="BACKGROUND">背景</option>
          <option value="IMAGE">图片</option>
          <option value="OFFICE_MAP">办公地图</option>
          <option value="ICON">图标</option>
          <option value="ILLUSTRATION">插画</option>
          <option value="UNCLASSIFIED">未分类</option>
        </select>
      </label>
      <div className="editor-upload-row">
        <select
          aria-label="上传素材分类"
          value={uploadCategory}
          onChange={(event) => setUploadCategory(event.target.value as "LOGO" | "IMAGE")}
        >
          <option value="IMAGE">图片</option>
          <option value="LOGO">Logo</option>
        </select>
        <label>
          上传 Logo 或图片
          <input
            type="file"
            aria-label="上传 Logo 或图片"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={uploading}
            onChange={handleUpload}
          />
        </label>
      </div>
      {uploading && <progress aria-label="素材上传进度">上传中</progress>}
      {loading && <p role="status">正在加载素材…</p>}
      {!loading && filtered.length === 0 && <p>没有符合条件的素材。</p>}
      <ul className="editor-asset-list">
        {filtered.map((asset) => {
          const selected = selectedAssetId === asset.id;
          return (
            <li key={asset.id} data-asset-id={asset.id}>
              <button
                type="button"
                className="editor-asset-card"
                aria-pressed={selected}
                onClick={() => onSelectedAssetId(asset.id)}
              >
                <Image src={asset.url} alt="" width={64} height={48} unoptimized />
                <span>
                  <strong>{asset.originalName}</strong>
                  <small>
                    {asset.category} · {asset.width ?? "?"}×{asset.height ?? "?"} · {Math.ceil(asset.sizeBytes / 1024)} KiB
                  </small>
                </span>
              </button>
              <div>
                <button
                  type="button"
                  disabled={asset.inspectionStatus !== "VALID"}
                  title={asset.inspectionStatus !== "VALID" ? "该素材尚未通过安全检查" : undefined}
                  onClick={() => onChoose(asset)}
                >
                  {selectedElementIsImage ? "选择或替换" : "设为背景"}
                </button>
                <button type="button" onClick={() => onDelete(asset)}>
                  删除素材
                </button>
              </div>
              <details>
                <summary>
                  引用 {asset.referenceCounts.draft + asset.referenceCounts.current + asset.referenceCounts.history}
                </summary>
                {asset.references.draft.map((reference, index) => (
                  <p key={`draft-${index}`}>{referenceLabel(reference, "草稿")}</p>
                ))}
                {asset.references.current.map((reference, index) => (
                  <p key={`current-${index}`}>{referenceLabel(reference, "当前发布")}</p>
                ))}
                {asset.references.history.map((reference, index) => (
                  <p key={`history-${index}`}>{referenceLabel(reference, "历史发布")}</p>
                ))}
                {asset.unused && <p>未使用，可删除</p>}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

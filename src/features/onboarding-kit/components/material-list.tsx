"use client";

import Link from "next/link";
import { CheckSquare, Download, Eye, FileText, PackageOpen, Search, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Material = {
  id: string;
  title: string;
  category: string;
  description: string | null;
  updatedAt: string;
  downloadUrl: string;
  currentVersion: {
    id: string;
    versionNumber: number;
    displayName: string;
    extension: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
  } | null;
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function fileNameFromDisposition(value: string | null) {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!encoded) return "CohortHarbor入职资料包.zip";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "CohortHarbor入职资料包.zip";
  }
}

export function MaterialList() {
  const [items, setItems] = useState<Material[]>([]);
  const [message, setMessage] = useState("正在加载入职资料…");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/onboarding-kit", { signal: controller.signal })
      .then(async (response) => ({
        response,
        result: (await response.json()) as { ok: boolean; items?: Material[]; message?: string },
      }))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.message ?? "资料加载失败");
        setItems(result.items ?? []);
        setMessage(result.items?.length ? "" : "目前还没有可下载的入职资料。");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError")
          setMessage(error instanceof Error ? error.message : "资料加载失败");
      });
    return () => controller.abort();
  }, []);

  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category))].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [items]
  );
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return items.filter(
      (item) =>
        (category === "ALL" || item.category === category) &&
        (!keyword ||
          `${item.title} ${item.category} ${item.description ?? ""} ${item.currentVersion?.displayName ?? ""}`
            .toLocaleLowerCase("zh-CN")
            .includes(keyword))
    );
  }, [category, items, query]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function downloadZip() {
    if (!selected.size) return;
    setDownloading(true);
    setMessage("正在安全生成资料包，请稍候…");
    try {
      const response = await fetch("/api/onboarding-kit/download-zip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ materialIds: [...selected] }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { message?: string };
        throw new Error(result.message ?? "资料包生成失败");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileNameFromDisposition(response.headers.get("content-disposition"));
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`已下载 ${selected.size} 项资料`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "资料包生成失败");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <section className="onboarding-filter" aria-label="资料筛选">
        <label>
          <span>搜索资料</span>
          <div>
            <Search aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、分类或文件名"
            />
          </div>
        </label>
        <label>
          <span>资料分类</span>
          <select
            aria-label="资料分类"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="ALL">全部分类</option>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <div className="onboarding-selection-actions">
          <button
            type="button"
            onClick={() =>
              setSelected((current) => new Set([...current, ...filtered.map((item) => item.id)]))
            }
          >
            <CheckSquare aria-hidden="true" />
            <span>选择当前筛选结果</span>
          </button>
          <button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}>
            <X aria-hidden="true" />
            <span>清空选择</span>
          </button>
        </div>
      </section>
      <div className="onboarding-download-bar">
        <div>
          <PackageOpen aria-hidden="true" />
          <span>
            <strong>已选择 {selected.size} 项</strong>
            <small>单个下载或将已选资料打包为 ZIP</small>
          </span>
        </div>
        <button
          type="button"
          disabled={!selected.size || downloading}
          onClick={() => void downloadZip()}
        >
          <Download aria-hidden="true" />
          <span>{downloading ? "正在生成…" : `下载已选 ${selected.size} 项`}</span>
        </button>
      </div>
      <p className="status-message" role="status">
        {message || `共 ${filtered.length} 项资料`}
      </p>
      <section className="onboarding-material-grid">
        {filtered.map((item) => {
          const checked = selected.has(item.id);
          return (
            <article key={item.id} className={checked ? "selected" : undefined}>
              <button
                className="material-select"
                type="button"
                aria-label={`${checked ? "取消选择" : "选择"}${item.title}`}
                aria-pressed={checked}
                onClick={() => toggle(item.id)}
              >
                {checked ? <CheckSquare aria-hidden="true" /> : <Square aria-hidden="true" />}
              </button>
              <span className="material-file-icon">
                <FileText aria-hidden="true" />
              </span>
              <div>
                <p>{item.category}</p>
                <h2>{item.title}</h2>
                <span>{item.description || "管理员暂未添加说明"}</span>
                <small>
                  v{item.currentVersion?.versionNumber ?? "-"} ·{" "}
                  {item.currentVersion?.displayName ?? "文件"} ·{" "}
                  {item.currentVersion ? formatBytes(item.currentVersion.sizeBytes) : "-"}
                </small>
              </div>
              <div className="material-item-actions">
                <Link href={`/onboarding-kit/${item.id}/preview`} className="material-view-link">
                  <Eye aria-hidden="true" className="w-4 h-4" />
                  <span>查看</span>
                </Link>
                <a href={item.downloadUrl} download className="material-download-link">
                  <Download aria-hidden="true" className="w-4 h-4" />
                  <span>下载</span>
                </a>
              </div>
            </article>
          );
        })}
      </section>
    </>
  );
}

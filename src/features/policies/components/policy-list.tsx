"use client";

import Link from "next/link";
import { RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";

type Policy = {
  id: string;
  name: string;
  category: string;
  versions: Array<{ id: string; versionNumber: string; effectiveDate: string }>;
};

export function PolicyList() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [message, setMessage] = useState("正在加载制度…");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [category, setCategory] = useState("ALL");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/policies", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok: boolean; policies?: Policy[]; message?: string }) => {
        setPolicies(result.policies ?? []);
        setMessage(result.ok && result.policies?.length ? "" : result.message ?? "暂无适用制度");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setMessage("制度加载失败");
      });
    return () => controller.abort();
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(policies.map((policy) => policy.category))).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [policies]
  );

  const filtered = useMemo(() => {
    const keyword = activeQuery.trim().toLocaleLowerCase("zh-CN");
    return policies.filter((policy) => {
      const matchesCategory = category === "ALL" || policy.category === category;
      const haystack = `${policy.name} ${policy.category} ${policy.versions[0]?.versionNumber ?? ""}`.toLocaleLowerCase("zh-CN");
      return matchesCategory && (!keyword || haystack.includes(keyword));
    });
  }, [category, policies, activeQuery]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveQuery(query);
  }

  function handleReset() {
    setQuery("");
    setActiveQuery("");
    setCategory("ALL");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <>
      <form className="policy-filter" aria-label="制度筛选" onSubmit={handleSearchSubmit}>
        <label className="filter-field-group">
          <span>名称或关键词</span>
          <div className="input-with-icon">
            <Search className="w-4 h-4 search-icon" aria-hidden="true" />
            <input
              aria-label="搜索制度名称、分类或版本"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveQuery(event.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="搜索制度名称、分类或版本"
            />
          </div>
        </label>
        <label className="filter-field-group">
          <span>制度分类</span>
          <select
            aria-label="制度分类"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="ALL">全部分类</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-actions">
          <button className="primary-action search-submit-btn" type="submit">
            <Search className="w-4 h-4" aria-hidden="true" />
            <span>搜索</span>
          </button>
          <button className="secondary-action search-reset-btn" type="button" onClick={handleReset}>
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            <span>重置</span>
          </button>
        </div>
      </form>
      <p className="status-message" role="status">
        {message || (filtered.length ? `共 ${filtered.length} 项制度` : "没有匹配的制度")}
      </p>
      <section className="policy-list">
        {filtered.map((policy, index) => (
          <Link href={`/employee/policies/${policy.id}`} key={policy.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <p>{policy.category}</p>
              <h2>{policy.name}</h2>
              <small>
                版本 {policy.versions[0]?.versionNumber} · 生效于{" "}
                {policy.versions[0]
                  ? new Date(policy.versions[0].effectiveDate).toLocaleDateString("zh-CN")
                  : "-"}
              </small>
            </div>
            <strong>阅读 →</strong>
          </Link>
        ))}
      </section>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";

import { CityCard } from "@/features/guides/components/city-card";

type Guide = { id: string; city: string; title: string; summary: string | null; recommended: boolean };

export function GuideList() {
  const [guides, setGuides] = useState<Guide[]>([]);
  const [message, setMessage] = useState("正在加载四地指南…");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/guides", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok: boolean; guides?: Guide[]; message?: string }) => {
        setGuides(result.guides ?? []);
        setMessage(result.ok ? "" : result.message ?? "指南加载失败");
      })
      .catch(() => setMessage("指南加载失败"));
    return () => controller.abort();
  }, []);
  return <><p className="status-message">{message}</p><section className="city-grid">{guides.map((guide) => <CityCard key={guide.id} {...guide} />)}</section></>;
}

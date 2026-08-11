"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Watermark } from "@/lib/ui/watermark";
import { PublishedScene } from "@/features/portal/components/published-scene";
import {
  PortalViewer,
  type EmployeePublishedPortal,
} from "@/features/portal/components/portal-viewer";

type Chapter = { id: string; title: string; body: string | null; address: string | null; contact: string | null; externalUrl: string | null; imageAsset: { id: string } | null };
type Guide = { title: string; summary: string | null; chapters: Chapter[] };
type GuideLoadState =
  | { key: string; status: "LOADING" }
  | {
      key: string;
      status: "READY";
      guide: Guide;
      watermarkName: string;
      watermarkOpacity: number;
    }
  | { key: string; status: "ERROR"; message: string };
type PortalLoadState =
  | { key: string; status: "LOADING" }
  | { key: string; status: "READY"; portal: EmployeePublishedPortal | null }
  | { key: string; status: "ERROR" };

export function GuideViewer({ city }: { city: string }) {
  const [guideLoad, setGuideLoad] = useState<GuideLoadState>({
    key: city,
    status: "LOADING",
  });
  const [portalLoad, setPortalLoad] = useState<PortalLoadState>({
    key: "",
    status: "LOADING",
  });
  const [viewport, setViewport] = useState<"DESKTOP" | "MOBILE">("DESKTOP");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const updateViewport = () => setViewport(media.matches ? "MOBILE" : "DESKTOP");
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/guides/${city}`, { signal: controller.signal })
      .then(async (response) => ({
        response,
        result: await response.json() as {
          ok: boolean;
          guide?: Guide;
          watermarkName?: string;
          watermarkOpacity?: number;
          message?: string;
        },
      }))
      .then(({ response, result }) => {
        if (!response.ok || !result.ok || !result.guide) {
          setGuideLoad({
            key: city,
            status: "ERROR",
            message: result.message ?? "指南加载失败",
          });
          return;
        }
        setGuideLoad({
          key: city,
          status: "READY",
          guide: result.guide,
          watermarkName: result.watermarkName ?? "",
          watermarkOpacity: result.watermarkOpacity ?? 0.07,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setGuideLoad({
          key: city,
          status: "ERROR",
          message: "指南加载失败，请刷新页面重试。",
        });
      });
    return () => controller.abort();
  }, [city]);
  useEffect(() => {
    const controller = new AbortController();
    const key = `${city}:${viewport}`;
    fetch(`/api/portal/${city}?viewport=${viewport}`, { signal: controller.signal })
      .then(async (response) => ({
        response,
        result: await response.json() as {
          ok: boolean;
          portal?: EmployeePublishedPortal | null;
          message?: string;
        },
      }))
      .then(({ response, result }) => {
        if (!response.ok || !result.ok) {
          setPortalLoad({ key, status: "ERROR" });
          return;
        }
        setPortalLoad({ key, status: "READY", portal: result.portal ?? null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPortalLoad({ key, status: "ERROR" });
      });
    return () => controller.abort();
  }, [city, viewport]);

  const guideState: GuideLoadState = guideLoad.key === city
    ? guideLoad
    : { key: city, status: "LOADING" };
  const portalKey = `${city}:${viewport}`;
  const portalState: PortalLoadState = portalLoad.key === portalKey
    ? portalLoad
    : { key: portalKey, status: "LOADING" };
  const guide = guideState.status === "READY" ? guideState.guide : null;
  const portal = portalState.status === "READY" ? portalState.portal : null;
  const showLegacy = portalState.status === "READY" && portal?.sceneVersion === 0;
  const portalPlaceholderTitle = guide?.title ?? ({
    SHANGHAI: "上海入职指南",
    SHENZHEN: "深圳入职指南",
    CHANGSHA: "长沙入职指南",
    XIAN: "西安入职指南",
  }[city] ?? "当前城市入职指南");

  return (
    <main className="guide-viewer-page">
      <Watermark
        name={guideState.status === "READY" ? guideState.watermarkName : ""}
        opacity={guideState.status === "READY" ? guideState.watermarkOpacity : 0.07}
      />
      <header><Link href="/employee/guides">← 返回四地指南</Link><p className="eyebrow">CITY GUIDE</p><h1>{guide?.title ?? "入职指南"}</h1><p>{guide?.summary}</p></header>
      {guideState.status === "LOADING" && (
        <p className="status-message" role="status">正在加载城市指南…</p>
      )}
      {guideState.status === "ERROR" && (
        <p className="status-message" role="alert">{guideState.message}</p>
      )}
      {portalState.status === "LOADING" && (
        <p className="status-message" role="status">正在加载门户内容…</p>
      )}
      {portalState.status === "ERROR" && (
        <p className="status-message" role="alert">
          门户内容加载失败，请刷新页面重试。
        </p>
      )}
      {portalState.status === "READY" && portal === null && (
        <p className="status-message portal-empty-state">
          {portalPlaceholderTitle}的门户内容尚未发布。
        </p>
      )}
      {portalState.status === "READY" && portal?.sceneVersion === 1 && (
        <PublishedScene scene={portal.scene} version={portal.version} />
      )}
      {showLegacy && <PortalViewer portal={portal} />}
      {showLegacy && (
        <section className="guide-pages">{guide?.chapters.map((chapter, index) => <article key={chapter.id}><div className="chapter-label"><span>{String(index + 1).padStart(2, "0")}</span><h2>{chapter.title}</h2></div>{chapter.imageAsset && (
          // Protected dynamic assets keep their source aspect ratio, including Shanghai's tall floor plan.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/files/${chapter.imageAsset.id}`} alt={`${guide.title} ${chapter.title}`} />
        )}{chapter.body && <p>{chapter.body}</p>}</article>)}</section>
      )}
    </main>
  );
}

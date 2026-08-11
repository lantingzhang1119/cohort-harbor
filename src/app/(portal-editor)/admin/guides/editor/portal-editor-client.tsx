"use client";

import dynamic from "next/dynamic";

import type { PortalViewportInput } from "@/features/portal/portal-scene";

const VisualEditor = dynamic(
  () => import("@/features/portal/editor/visual-editor").then(
    (module) => module.VisualEditor,
  ),
  {
    ssr: false,
    loading: () => <main aria-busy="true">正在打开可视化编辑器…</main>,
  },
);

export function PortalEditorClient({
  userId,
  initialCity,
  initialViewport,
}: {
  userId: string;
  initialCity: string;
  initialViewport: PortalViewportInput;
}) {
  return (
    <VisualEditor
      userId={userId}
      initialCity={initialCity}
      initialViewport={initialViewport}
    />
  );
}

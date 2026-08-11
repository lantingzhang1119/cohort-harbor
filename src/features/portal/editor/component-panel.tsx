"use client";

import type { ChangeEvent } from "react";

import type { PortalElement, PortalElementType, PortalViewportInput } from "@/features/portal/portal-scene";

const COMPONENTS = [
  ["TEXT", "文字"],
  ["RECT", "矩形"],
  ["CIRCLE", "圆形"],
  ["ELLIPSE", "椭圆"],
  ["ROUND_RECT", "圆角矩形"],
  ["TRIANGLE", "三角形"],
  ["LINE", "线条"],
  ["ARROW", "箭头"],
  ["FREEHAND", "自由绘制"],
  ["IMAGE", "图片"],
  ["ICON", "图标"],
  ["BUTTON", "按钮"],
  ["MARKER", "标记点"],
] as const satisfies readonly (readonly [PortalElementType, string])[];

const NAMES = Object.fromEntries(COMPONENTS) as Record<PortalElementType, string>;

function idFor(type: PortalElementType) {
  const suffix = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${type.toLowerCase()}-${suffix}`.slice(0, 100);
}

function base<T extends PortalElementType>(
  type: T,
  width: number,
  height: number,
  center: { x: number; y: number },
) {
  return {
    id: idFor(type),
    type,
    name: NAMES[type],
    x: Math.max(0, center.x - width / 2),
    y: Math.max(0, center.y - height / 2),
    width,
    height,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    locked: false,
    hidden: false,
  } as const;
}

function defaultImageSize(
  viewport: PortalViewportInput,
  naturalSize?: { width: number | null; height: number | null },
) {
  const naturalWidth = naturalSize?.width ?? 4;
  const naturalHeight = naturalSize?.height ?? 3;
  const maxWidth = viewport === "MOBILE" ? 300 : 320;
  const maxHeight = 240;
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(1, naturalWidth * scale),
    height: Math.max(1, naturalHeight * scale),
  };
}

export function createDefaultPortalElement(
  type: PortalElementType,
  viewport: PortalViewportInput,
  center: { x: number; y: number },
  imageAssetId: string,
  imageNaturalSize?: { width: number | null; height: number | null },
): PortalElement {
  const narrow = viewport === "MOBILE";
  switch (type) {
    case "TEXT":
      return {
        ...base(type, narrow ? 250 : 320, 72, center),
        text: "双击编辑文字",
        color: "#172033",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 30,
        fontWeight: 500,
        lineHeight: 1.4,
        align: "LEFT",
        italic: false,
        underline: false,
        letterSpacing: 0,
        backgroundColor: null,
        action: null,
      };
    case "RECT":
    case "CIRCLE":
    case "ELLIPSE":
    case "TRIANGLE":
      return {
        ...base(type, type === "CIRCLE" ? 120 : narrow ? 220 : 260, type === "CIRCLE" ? 120 : 140, center),
        fillEnabled: true,
        fill: "#DCEBFA",
        lastFillColor: "#DCEBFA",
        stroke: "#2563A7",
        strokeWidth: 2,
        dash: "SOLID",
        shadow: null,
      };
    case "ROUND_RECT":
      return {
        ...base(type, narrow ? 220 : 260, 140, center),
        fillEnabled: true,
        fill: "#DCEBFA",
        lastFillColor: "#DCEBFA",
        stroke: "#2563A7",
        strokeWidth: 2,
        cornerRadius: 20,
        dash: "SOLID",
        shadow: null,
      };
    case "LINE":
      return {
        ...base(type, narrow ? 220 : 280, 12, center),
        stroke: "#2563A7",
        strokeWidth: 4,
        dash: "SOLID",
        shadow: null,
      };
    case "ARROW":
      return {
        ...base(type, narrow ? 220 : 280, 40, center),
        stroke: "#2563A7",
        strokeWidth: 4,
        pointerLength: 18,
        pointerWidth: 16,
        dash: "SOLID",
        shadow: null,
      };
    case "FREEHAND":
      throw new Error("自由绘制元素只能通过画笔手势创建");
    case "IMAGE": {
      const imageSize = defaultImageSize(viewport, imageNaturalSize);
      return {
        ...base(type, imageSize.width, imageSize.height, center),
        assetId: imageAssetId,
        altText: "门户图片",
        fitMode: "COVER",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        cornerRadius: 0,
        lockAspectRatio: true,
        action: null,
      };
    }
    case "ICON":
      return {
        ...base(type, 72, 72, center),
        iconName: "MapPin",
        color: "#2563A7",
        action: null,
      };
    case "BUTTON":
      return {
        ...base(type, 180, 56, center),
        text: "了解更多",
        backgroundColor: "#2563A7",
        cornerRadius: 12,
        action: { href: "/", target: "_self" },
        color: "#FFFFFF",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 18,
        fontWeight: 600,
        lineHeight: 1.2,
        align: "CENTER",
        border: null,
        shadow: null,
      };
    case "MARKER":
      return {
        ...base(type, 180, 52, center),
        text: "位置标记",
        color: "#FFFFFF",
        backgroundColor: "#C2410C",
        iconName: "MapPin",
        title: "位置详情",
        description: "点击查看位置说明",
      };
  }
}

export function ComponentPanel({
  disabled,
  uploading,
  onCreate,
  onUploadImage,
}: {
  disabled?: boolean;
  uploading?: boolean;
  onCreate(type: PortalElementType): void;
  onUploadImage?(file: File): void;
}) {
  const uploadImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUploadImage?.(file);
    event.target.value = "";
  };

  return (
    <section aria-label="添加组件面板">
      <h2>添加组件</h2>
      <p>组件会加入当前可见画布中心。</p>
      <div className="editor-component-grid">
        {COMPONENTS.map(([type, label]) => (
          <button
            key={type}
            type="button"
            disabled={disabled}
            data-component-type={type}
            onClick={() => onCreate(type)}
          >
            <span aria-hidden="true">{type}</span>
            {label}
          </button>
        ))}
      </div>
      <label className="editor-direct-upload">
        <strong>{uploading ? "正在上传…" : "上传文件"}</strong>
        <span>上传本地图片并添加到画布</span>
        <input
          type="file"
          aria-label="上传本地图片并添加到画布"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={disabled || uploading}
          onChange={uploadImage}
        />
      </label>
    </section>
  );
}

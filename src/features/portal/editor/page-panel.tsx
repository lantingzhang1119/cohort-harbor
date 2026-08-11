"use client";

import type { ChangeEvent } from "react";
import Image from "next/image";

import type { EditorAction } from "@/features/portal/editor/editor-types";
import type { PortalSceneV1 } from "@/features/portal/portal-scene";

import type { PortalAsset } from "./asset-panel";

export function PagePanel({
  background,
  assets,
  loading,
  uploading,
  dispatch,
  onUpload,
}: {
  background: PortalSceneV1["background"];
  assets: PortalAsset[];
  loading: boolean;
  uploading: boolean;
  dispatch(action: EditorAction): void;
  onUpload(file: File, category: "BACKGROUND"): void;
}) {
  const locked = background.locked;
  const numberPatch = (
    key: "positionX" | "positionY",
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) dispatch({ type: "UPDATE_BACKGROUND", patch: { [key]: value } });
  };

  return (
    <section aria-label="页面设置面板">
      <h2>页面设置</h2>
      <fieldset disabled={locked}>
        <legend>背景</legend>
        <label>
          背景色
          <input
            aria-label="背景色"
            type="color"
            value={background.backgroundColor}
            onChange={(event) => dispatch({
              type: "UPDATE_BACKGROUND",
              patch: { backgroundColor: event.target.value.toUpperCase() },
            })}
          />
        </label>
        <div role="radiogroup" aria-label="背景显示方式">
          <label>
            <input
              type="radio"
              name="background-fit"
              checked={background.fitMode === "CONTAIN"}
              onChange={() => dispatch({ type: "UPDATE_BACKGROUND", patch: { fitMode: "CONTAIN" } })}
            />
            完整显示
          </label>
          <label>
            <input
              type="radio"
              name="background-fit"
              checked={background.fitMode === "COVER"}
              onChange={() => dispatch({ type: "UPDATE_BACKGROUND", patch: { fitMode: "COVER" } })}
            />
            铺满显示
          </label>
          <label>
            <input
              type="radio"
              name="background-fit"
              checked={background.fitMode === "AUTO_HEIGHT"}
              disabled={!background.assetId || !background.naturalWidth || !background.naturalHeight}
              onChange={() => dispatch({ type: "UPDATE_BACKGROUND", patch: { fitMode: "AUTO_HEIGHT" } })}
            />
            长图完整显示（高度自适应）
          </label>
        </div>
        <label>
          背景 X 位置
          <input
            aria-label="背景 X 位置"
            type="number"
            min={0}
            max={100}
            value={background.positionX}
            disabled={background.fitMode === "AUTO_HEIGHT"}
            onChange={(event) => numberPatch("positionX", event)}
          />
        </label>
        <label>
          背景 Y 位置
          <input
            aria-label="背景 Y 位置"
            type="number"
            min={0}
            max={100}
            value={background.positionY}
            disabled={background.fitMode === "AUTO_HEIGHT"}
            onChange={(event) => numberPatch("positionY", event)}
          />
        </label>
        <label>
          上传背景图片
          <input
            type="file"
            aria-label="上传背景图片"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file, "BACKGROUND");
              event.target.value = "";
            }}
          />
        </label>
        {uploading && <progress aria-label="背景上传进度">上传中</progress>}
        {background.assetId && (
          <button
            type="button"
            onClick={() => dispatch({
              type: "UPDATE_BACKGROUND",
              patch: {
                assetId: null,
                naturalWidth: null,
                naturalHeight: null,
                ...(background.fitMode === "AUTO_HEIGHT" ? { fitMode: "COVER" as const } : {}),
              },
            })}
          >
            删除背景素材
          </button>
        )}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={background.locked}
          onChange={(event) => dispatch({
            type: "SET_BACKGROUND_LOCKED",
            locked: event.target.checked,
          })}
        />
        锁定背景
      </label>
      <h3>从素材库选择</h3>
      {loading && <p role="status">正在加载素材…</p>}
      <ul className="editor-page-assets">
        {assets.map((asset) => (
          <li key={asset.id}>
            <Image src={asset.url} alt="" width={56} height={42} unoptimized />
            <span>{asset.originalName}</span>
            <button
              type="button"
              disabled={locked || asset.inspectionStatus !== "VALID"}
              onClick={() => dispatch({
                type: "UPDATE_BACKGROUND",
                patch: {
                  assetId: asset.id,
                  naturalWidth: asset.width,
                  naturalHeight: asset.height,
                },
              })}
            >
              设为背景
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

"use client";

import { useState } from "react";

import {
  safePortalActionSchema,
  type SafePortalAction,
} from "@/features/portal/portal-actions";
import {
  PORTAL_ICON_NAMES,
  type PortalDashStyle,
  type PortalElement,
  type PortalShadow,
} from "@/features/portal/portal-scene";
import {
  disableClosedShapeFill,
  enableClosedShapeFill,
} from "@/features/portal/portal-shape-fill";

import type { PortalAsset } from "./asset-panel";

type PropertyPanelProps = {
  element: PortalElement | null;
  assets: PortalAsset[];
  onCommit(patch: Partial<PortalElement>): void;
  onRename(name: string): void;
  onHidden(hidden: boolean): void;
  onLocked(locked: boolean): void;
  cropActive?: boolean;
  cropDisabled?: boolean;
  onStartCrop?(): void;
};

function ActionFields({
  labelPrefix,
  action,
  optional,
  disabled,
  onAction,
}: {
  labelPrefix: string;
  action: SafePortalAction | null;
  optional: boolean;
  disabled: boolean;
  onAction(action: SafePortalAction | null): void;
}) {
  const [draft, setDraft] = useState(action?.href ?? "/");
  const [error, setError] = useState<string | null>(null);
  const target = action?.target ?? "_self";
  const hrefLabel = labelPrefix ? `${labelPrefix}链接地址` : "链接地址";
  const targetLabel = labelPrefix ? `${labelPrefix}打开方式` : "打开方式";

  const commit = (href: string, nextTarget: SafePortalAction["target"]) => {
    const parsed = safePortalActionSchema.safeParse({ href, target: nextTarget });
    if (!parsed.success) {
      setError("链接必须是站内路径或无凭据的 HTTPS 地址");
      return;
    }
    setError(null);
    onAction(parsed.data);
  };

  return (
    <>
      {optional && (
        <label>
          <input
            aria-label={`${labelPrefix}链接`}
            type="checkbox"
            checked={action !== null}
            disabled={disabled}
            onChange={(event) => {
              setError(null);
              if (!event.target.checked) {
                onAction(null);
                return;
              }
              setDraft("/");
              onAction({ href: "/", target: "_self" });
            }}
          />
          启用链接
        </label>
      )}
      {action !== null && (
        <>
          <label>
            链接地址
            <input
              aria-label={hrefLabel}
              value={draft}
              disabled={disabled}
              maxLength={2048}
              aria-invalid={error ? "true" : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                commit(event.target.value, target);
              }}
            />
          </label>
          <label>
            打开方式
            <select
              aria-label={targetLabel}
              value={target}
              disabled={disabled}
              onChange={(event) => commit(
                draft,
                event.target.value as SafePortalAction["target"],
              )}
            >
              <option value="_self">当前窗口</option>
              <option value="_blank">新窗口</option>
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </>
  );
}

function NumberField({
  label,
  value,
  disabled,
  min,
  max,
  step = 1,
  onValue,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onValue(value: number): void;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={value}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onValue(next);
        }}
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  disabled,
  onValue,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onValue(value: string): void;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="color"
        value={value}
        disabled={disabled}
        onChange={(event) => onValue(event.target.value.toUpperCase())}
      />
    </label>
  );
}

function DashField({
  label = "线型",
  value,
  disabled,
  onValue,
}: {
  label?: string;
  value: PortalDashStyle;
  disabled?: boolean;
  onValue(value: PortalDashStyle): void;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onValue(event.target.value as PortalDashStyle)}
      >
        <option value="SOLID">实线</option>
        <option value="DASHED">虚线</option>
        <option value="DOTTED">点线</option>
      </select>
    </label>
  );
}

const DEFAULT_SHADOW: PortalShadow = {
  color: "#000000",
  opacity: 0.25,
  blur: 12,
  offsetX: 0,
  offsetY: 4,
};

function ShadowFields({
  label,
  shadow,
  disabled,
  onValue,
}: {
  label: string;
  shadow: PortalShadow | null;
  disabled?: boolean;
  onValue(shadow: PortalShadow | null): void;
}) {
  if (shadow === null) {
    return (
      <label>
        <input
          aria-label={label}
          type="checkbox"
          checked={false}
          disabled={disabled}
          onChange={() => onValue(DEFAULT_SHADOW)}
        />
        启用阴影
      </label>
    );
  }

  return (
    <>
      <label>
        <input
          aria-label={label}
          type="checkbox"
          checked
          disabled={disabled}
          onChange={() => onValue(null)}
        />
        启用阴影
      </label>
      <ColorField
        label="阴影颜色"
        value={shadow.color}
        disabled={disabled}
        onValue={(color) => onValue({ ...shadow, color })}
      />
      <NumberField
        label="阴影透明度"
        value={Math.round(shadow.opacity * 100)}
        min={0}
        max={100}
        disabled={disabled}
        onValue={(opacity) => onValue({ ...shadow, opacity: opacity / 100 })}
      />
      <NumberField
        label="阴影模糊"
        value={shadow.blur}
        min={0}
        max={100}
        disabled={disabled}
        onValue={(blur) => onValue({ ...shadow, blur })}
      />
      <NumberField
        label="阴影水平偏移"
        value={shadow.offsetX}
        min={-200}
        max={200}
        disabled={disabled}
        onValue={(offsetX) => onValue({ ...shadow, offsetX })}
      />
      <NumberField
        label="阴影垂直偏移"
        value={shadow.offsetY}
        min={-200}
        max={200}
        disabled={disabled}
        onValue={(offsetY) => onValue({ ...shadow, offsetY })}
      />
    </>
  );
}

function TextStyleFields({
  element,
  disabled,
  onCommit,
  colorLabel = "文字颜色",
}: {
  element: Extract<PortalElement, { type: "TEXT" | "BUTTON" }>;
  disabled: boolean;
  onCommit(patch: Partial<PortalElement>): void;
  colorLabel?: string;
}) {
  return (
    <>
      <label>
        字体
        <select
          aria-label="字体"
          value={element.fontFamily}
          disabled={disabled}
          onChange={(event) => onCommit({ fontFamily: event.target.value as "Noto Sans SC Variable" })}
        >
          <option value="Noto Sans SC Variable">Noto Sans SC</option>
        </select>
      </label>
      <NumberField label="字号" value={element.fontSize} min={6} max={300} disabled={disabled} onValue={(fontSize) => onCommit({ fontSize })} />
      <label>
        字重
        <select
          aria-label="字重"
          value={element.fontWeight}
          disabled={disabled}
          onChange={(event) => onCommit({ fontWeight: Number(event.target.value) })}
        >
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
            <option key={weight} value={weight}>{weight}</option>
          ))}
        </select>
      </label>
      <NumberField label="行高" value={element.lineHeight} min={0.5} max={4} step={0.1} disabled={disabled} onValue={(lineHeight) => onCommit({ lineHeight })} />
      <ColorField label={colorLabel} value={element.color} disabled={disabled} onValue={(color) => onCommit({ color })} />
      <label>
        对齐
        <select
          aria-label="对齐"
          value={element.align}
          disabled={disabled}
          onChange={(event) => onCommit({ align: event.target.value as "LEFT" | "CENTER" | "RIGHT" })}
        >
          <option value="LEFT">左对齐</option>
          <option value="CENTER">居中</option>
          <option value="RIGHT">右对齐</option>
        </select>
      </label>
    </>
  );
}

function GeometryFields({
  element,
  disabled,
  onCommit,
}: {
  element: PortalElement;
  disabled: boolean;
  onCommit(patch: Partial<PortalElement>): void;
}) {
  return (
    <details>
      <summary>精确调整</summary>
      <div className="editor-geometry-grid">
        <NumberField label="X" value={element.x} disabled={disabled} onValue={(x) => onCommit({ x })} />
        <NumberField label="Y" value={element.y} disabled={disabled} onValue={(y) => onCommit({ y })} />
        <NumberField label="W" value={element.width} min={1} disabled={disabled} onValue={(width) => onCommit({ width })} />
        <NumberField label="H" value={element.height} min={1} disabled={disabled} onValue={(height) => onCommit({ height })} />
        <NumberField label="旋转" value={element.rotation} min={-360} max={360} disabled={disabled} onValue={(rotation) => onCommit({ rotation })} />
      </div>
    </details>
  );
}

export function PropertyPanel({
  element,
  assets,
  onCommit,
  onRename,
  onHidden,
  onLocked,
  cropActive = false,
  cropDisabled = false,
  onStartCrop,
}: PropertyPanelProps) {
  if (!element) {
    return (
      <div className="editor-empty-properties">
        <span aria-hidden="true">◇</span>
        <strong>尚未选择组件</strong>
        <p>从左侧添加组件，或在画布中选择现有元素后调整属性。</p>
      </div>
    );
  }

  const disabled = element.locked || cropActive;
  const shape = element.type === "RECT"
    || element.type === "CIRCLE"
    || element.type === "ELLIPSE"
    || element.type === "ROUND_RECT"
    || element.type === "TRIANGLE"
    ? element
    : null;
  const line = element.type === "LINE" || element.type === "ARROW" ? element : null;
  const freehand = element.type === "FREEHAND" ? element : null;

  return (
    <form className="editor-property-form" onSubmit={(event) => event.preventDefault()}>
      <fieldset disabled={disabled}>
        <legend>通用</legend>
        <label>
          图层名称
          <input
            aria-label="图层名称"
            value={element.name}
            maxLength={100}
            onChange={(event) => onRename(event.target.value)}
          />
        </label>
        <NumberField
          label="透明度"
          value={Math.round(element.opacity * 100)}
          min={0}
          max={100}
          onValue={(opacity) => onCommit({ opacity: opacity / 100 })}
        />
        <label>
          <input type="checkbox" checked={!element.hidden} onChange={(event) => onHidden(!event.target.checked)} />
          可见
        </label>
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={element.locked}
          disabled={cropActive}
          onChange={(event) => onLocked(event.target.checked)}
        />
        锁定
      </label>

      {element.type === "TEXT" && (
        <fieldset disabled={disabled}>
          <legend>文字</legend>
          <label>
            文字内容
            <textarea
              aria-label="文字内容"
              value={element.text}
              maxLength={10_000}
              onChange={(event) => onCommit({ text: event.target.value })}
            />
          </label>
          <TextStyleFields element={element} disabled={disabled} onCommit={onCommit} />
          <label>
            <input
              aria-label="斜体"
              type="checkbox"
              checked={element.italic}
              onChange={(event) => onCommit({ italic: event.target.checked })}
            />
            斜体
          </label>
          <label>
            <input
              aria-label="下划线"
              type="checkbox"
              checked={element.underline}
              onChange={(event) => onCommit({ underline: event.target.checked })}
            />
            下划线
          </label>
          <NumberField
            label="字距"
            value={element.letterSpacing}
            min={-5}
            max={50}
            step={0.5}
            onValue={(letterSpacing) => onCommit({ letterSpacing })}
          />
          <label>
            <input
              aria-label="文字背景"
              type="checkbox"
              checked={element.backgroundColor !== null}
              onChange={(event) => onCommit({
                backgroundColor: event.target.checked ? "#FFFFFF" : null,
              })}
            />
            启用文字背景
          </label>
          {element.backgroundColor !== null && (
            <ColorField
              label="文字背景色"
              value={element.backgroundColor}
              onValue={(backgroundColor) => onCommit({ backgroundColor })}
            />
          )}
          <ActionFields
            key={`${element.id}:${element.action?.href ?? "none"}`}
            labelPrefix="文字"
            action={element.action}
            optional
            disabled={disabled}
            onAction={(action) => onCommit({ action })}
          />
        </fieldset>
      )}

      {shape && (
        <fieldset disabled={disabled}>
          <legend>形状</legend>
          <label>
            <input
              aria-label="启用填充"
              type="checkbox"
              checked={shape.fillEnabled}
              onChange={(event) => {
                if (event.target.checked) {
                  onCommit(enableClosedShapeFill(shape));
                  return;
                }
                onCommit(disableClosedShapeFill(shape));
              }}
            />
            启用填充
          </label>
          {shape.fillEnabled ? (
            <ColorField
              label="填充颜色"
              value={shape.fill ?? shape.lastFillColor}
              onValue={(fill) => onCommit({ fill, lastFillColor: fill, fillEnabled: true })}
            />
          ) : (
            <p
              className="editor-fill-disabled-status"
              role="status"
              aria-label="无填充"
              aria-live="polite"
            >
              无填充
            </p>
          )}
          <button
            type="button"
            aria-label="无填充"
            disabled={disabled || !shape.fillEnabled}
            onClick={() => onCommit(disableClosedShapeFill(shape))}
          >
            无填充
          </button>
          <label>
            <input
              aria-label="启用边框"
              type="checkbox"
              checked={shape.stroke !== null}
              onChange={(event) => onCommit({
                stroke: event.target.checked ? "#1E88E5" : null,
              })}
            />
            启用边框
          </label>
          {shape.stroke !== null && (
            <>
              <ColorField label="描边颜色" value={shape.stroke} onValue={(stroke) => onCommit({ stroke })} />
              <NumberField label="描边宽度" value={shape.strokeWidth} min={0} max={100} onValue={(strokeWidth) => onCommit({ strokeWidth })} />
              <DashField value={shape.dash} onValue={(dash) => onCommit({ dash })} />
            </>
          )}
          <ShadowFields
            label="形状阴影"
            shadow={shape.shadow}
            onValue={(shadow) => onCommit({ shadow })}
          />
          {shape.type === "ROUND_RECT" && (
            <NumberField label="圆角" value={shape.cornerRadius} min={0} max={720} onValue={(cornerRadius) => onCommit({ cornerRadius })} />
          )}
        </fieldset>
      )}

      {line && (
        <fieldset disabled={disabled}>
          <legend>{line.type === "ARROW" ? "箭头" : "线条"}</legend>
          <ColorField label="线条颜色" value={line.stroke} onValue={(stroke) => onCommit({ stroke })} />
          <NumberField label="线宽" value={line.strokeWidth} min={0.1} max={100} step={0.5} onValue={(strokeWidth) => onCommit({ strokeWidth })} />
          <DashField value={line.dash} onValue={(dash) => onCommit({ dash })} />
          <ShadowFields
            label="线条阴影"
            shadow={line.shadow}
            onValue={(shadow) => onCommit({ shadow })}
          />
          {line.type === "ARROW" && (
            <>
              <NumberField label="箭头长度" value={line.pointerLength} min={0.1} max={300} onValue={(pointerLength) => onCommit({ pointerLength })} />
              <NumberField label="箭头宽度" value={line.pointerWidth} min={0.1} max={300} onValue={(pointerWidth) => onCommit({ pointerWidth })} />
            </>
          )}
        </fieldset>
      )}

      {freehand && (
        <fieldset disabled={disabled}>
          <legend>自由画笔</legend>
          <ColorField
            label="线条颜色"
            value={freehand.stroke}
            onValue={(stroke) => onCommit({ stroke })}
          />
          <NumberField
            label="线宽"
            value={freehand.strokeWidth}
            min={0.1}
            max={100}
            step={0.5}
            onValue={(strokeWidth) => onCommit({ strokeWidth })}
          />
          <NumberField
            label="平滑度"
            value={freehand.tension}
            min={0}
            max={1}
            step={0.05}
            onValue={(tension) => onCommit({ tension })}
          />
          <p role="note">圆角端点 · 圆角连接</p>
        </fieldset>
      )}

      {element.type === "IMAGE" && (
        <>
          <button
            type="button"
            aria-label="裁剪图片"
            aria-pressed={cropActive}
            disabled={element.locked || element.hidden || cropDisabled}
            onClick={() => {
              if (!cropActive) onStartCrop?.();
            }}
          >
            {cropActive ? "正在裁剪图片" : "裁剪图片"}
          </button>
          <fieldset disabled={disabled}>
            <legend>图片</legend>
          <label>
            图片素材
            <select aria-label="图片素材" value={element.assetId} onChange={(event) => onCommit({ assetId: event.target.value })}>
              {!assets.some(({ id }) => id === element.assetId) && <option value={element.assetId}>待替换素材</option>}
              {assets.filter(({ inspectionStatus }) => inspectionStatus === "VALID").map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.originalName}</option>
              ))}
            </select>
          </label>
          <label>
            替代文字
            <input aria-label="替代文字" value={element.altText} maxLength={300} onChange={(event) => onCommit({ altText: event.target.value })} />
          </label>
          <label>
            图片显示方式
            <select aria-label="图片显示方式" value={element.fitMode} onChange={(event) => onCommit({ fitMode: event.target.value as "CONTAIN" | "COVER" })}>
              <option value="CONTAIN">完整显示</option>
              <option value="COVER">铺满显示</option>
            </select>
          </label>
          <NumberField label="裁剪 X" value={element.crop.x} min={0} max={1} step={0.01} onValue={(x) => onCommit({ crop: { ...element.crop, x } })} />
          <NumberField label="裁剪 Y" value={element.crop.y} min={0} max={1} step={0.01} onValue={(y) => onCommit({ crop: { ...element.crop, y } })} />
          <NumberField label="裁剪宽度" value={element.crop.width} min={0.01} max={1} step={0.01} onValue={(width) => onCommit({ crop: { ...element.crop, width } })} />
          <NumberField label="裁剪高度" value={element.crop.height} min={0.01} max={1} step={0.01} onValue={(height) => onCommit({ crop: { ...element.crop, height } })} />
          <NumberField
            label="图片圆角"
            value={element.cornerRadius}
            min={0}
            max={720}
            onValue={(cornerRadius) => onCommit({ cornerRadius })}
          />
          <label>
            <input
              type="checkbox"
              aria-label="锁定宽高比"
              checked={element.lockAspectRatio !== false}
              onChange={(event) => onCommit({ lockAspectRatio: event.target.checked })}
            />
            锁定宽高比
          </label>
          <ActionFields
            key={`${element.id}:${element.action?.href ?? "none"}`}
            labelPrefix="图片"
            action={element.action}
            optional
            disabled={disabled}
            onAction={(action) => onCommit({ action })}
          />
          </fieldset>
        </>
      )}

      {element.type === "ICON" && (
        <fieldset disabled={disabled}>
          <legend>图标</legend>
          <label>
            系统图标
            <select aria-label="系统图标" value={element.iconName} onChange={(event) => onCommit({ iconName: event.target.value as typeof element.iconName })}>
              {PORTAL_ICON_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <ColorField label="图标颜色" value={element.color} onValue={(color) => onCommit({ color })} />
          <ActionFields
            key={`${element.id}:${element.action?.href ?? "none"}`}
            labelPrefix="图标"
            action={element.action}
            optional
            disabled={disabled}
            onAction={(action) => onCommit({ action })}
          />
        </fieldset>
      )}

      {element.type === "BUTTON" && (
        <fieldset disabled={disabled}>
          <legend>按钮</legend>
          <label>
            按钮文案
            <input aria-label="按钮文案" value={element.text} maxLength={300} onChange={(event) => onCommit({ text: event.target.value })} />
          </label>
          <TextStyleFields element={element} disabled={disabled} onCommit={onCommit} colorLabel="按钮文字颜色" />
          <ColorField label="按钮背景色" value={element.backgroundColor} onValue={(backgroundColor) => onCommit({ backgroundColor })} />
          <NumberField label="按钮圆角" value={element.cornerRadius} min={0} max={720} onValue={(cornerRadius) => onCommit({ cornerRadius })} />
          <label>
            <input
              aria-label="按钮边框"
              type="checkbox"
              checked={element.border !== null}
              onChange={(event) => onCommit({
                border: event.target.checked
                  ? { color: "#FFFFFF", width: 1, dash: "SOLID" }
                  : null,
              })}
            />
            启用边框
          </label>
          {element.border !== null && (
            <>
              <ColorField
                label="边框颜色"
                value={element.border.color}
                onValue={(color) => onCommit({ border: { ...element.border!, color } })}
              />
              <NumberField
                label="边框宽度"
                value={element.border.width}
                min={0.5}
                max={100}
                step={0.5}
                onValue={(width) => onCommit({ border: { ...element.border!, width } })}
              />
              <DashField
                label="边框线型"
                value={element.border.dash}
                onValue={(dash) => onCommit({ border: { ...element.border!, dash } })}
              />
            </>
          )}
          <ShadowFields
            label="按钮阴影"
            shadow={element.shadow}
            onValue={(shadow) => onCommit({ shadow })}
          />
          <ActionFields
            key={`${element.id}:${element.action.href}`}
            labelPrefix=""
            action={element.action}
            optional={false}
            disabled={disabled}
            onAction={(action) => {
              if (action !== null) onCommit({ action });
            }}
          />
        </fieldset>
      )}

      {element.type === "MARKER" && (
        <fieldset disabled={disabled}>
          <legend>标记点</legend>
          <label>
            标记文案
            <input aria-label="标记文案" value={element.text} maxLength={300} onChange={(event) => onCommit({ text: event.target.value })} />
          </label>
          <label>
            标记图标
            <select
              aria-label="标记图标"
              value={element.iconName}
              onChange={(event) => onCommit({
                iconName: event.target.value as typeof element.iconName,
              })}
            >
              {PORTAL_ICON_NAMES.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            标记标题
            <input
              aria-label="标记标题"
              value={element.title}
              maxLength={120}
              onChange={(event) => onCommit({ title: event.target.value })}
            />
          </label>
          <label>
            标记说明
            <textarea
              aria-label="标记说明"
              value={element.description}
              maxLength={500}
              onChange={(event) => onCommit({ description: event.target.value })}
            />
          </label>
          <ColorField label="标记前景色" value={element.color} onValue={(color) => onCommit({ color })} />
          <ColorField label="标记背景色" value={element.backgroundColor} onValue={(backgroundColor) => onCommit({ backgroundColor })} />
        </fieldset>
      )}

      <GeometryFields element={element} disabled={disabled} onCommit={onCommit} />
    </form>
  );
}

"use client";

import type { EditorAction, EditorState } from "@/features/portal/editor/editor-types";

/**
 * Toolbar zoom steps land on the adjacent 10% grid point:
 * shrink floors strictly below current (72% → 70%, 70% → 60%);
 * enlarge ceils strictly above current (76% → 80%, 80% → 90%).
 */
export function stepZoomToAdjacentTenPercent(zoom: number, direction: -1 | 1): number {
  const percent = zoom * 100;
  const nextPercent = direction < 0
    ? Math.floor((percent - 1e-9) / 10) * 10
    : Math.ceil((percent + 1e-9) / 10) * 10;
  return Math.min(4, Math.max(0.1, nextPercent / 100));
}

export function EditorToolbar({
  state,
  dispatch,
  onFit,
  disabled = false,
}: {
  state: EditorState;
  dispatch(action: EditorAction): void;
  onFit(): void;
  disabled?: boolean;
}) {
  const hasSelection = state.selection.length > 0;
  return (
    <div className="editor-edit-actions" role="toolbar" aria-label="画布编辑操作">
      <button type="button" aria-label="撤销" disabled={disabled || state.past.length === 0} onClick={() => dispatch({ type: "UNDO" })}>↶</button>
      <button type="button" aria-label="重做" disabled={disabled || state.future.length === 0} onClick={() => dispatch({ type: "REDO" })}>↷</button>
      <button type="button" aria-label="删除选中元素" disabled={disabled || !hasSelection} onClick={() => dispatch({ type: "DELETE_ELEMENT" })}>删除</button>
      <button type="button" aria-label="复制" disabled={disabled || !hasSelection} onClick={() => dispatch({ type: "COPY_SELECTION" })}>复制</button>
      <button type="button" aria-label="粘贴" disabled={disabled || !state.clipboard?.elements.length} onClick={() => dispatch({ type: "PASTE" })}>粘贴</button>
      <button
        type="button"
        aria-label={state.snapEnabled ? "关闭吸附" : "开启吸附"}
        aria-pressed={state.snapEnabled}
        disabled={disabled}
        onClick={() => dispatch({ type: "SET_SNAP_ENABLED", enabled: !state.snapEnabled })}
      >
        吸附
      </button>
      <button
        type="button"
        aria-label="缩小"
        disabled={disabled}
        onClick={() => {
          dispatch({ type: "SET_ZOOM", zoom: stepZoomToAdjacentTenPercent(state.zoom, -1) });
        }}
      >
        −
      </button>
      <output aria-label="缩放比例">{Math.round(state.zoom * 100)}%</output>
      <button
        type="button"
        aria-label="放大"
        disabled={disabled}
        onClick={() => {
          dispatch({ type: "SET_ZOOM", zoom: stepZoomToAdjacentTenPercent(state.zoom, 1) });
        }}
      >
        ＋
      </button>
      <button type="button" aria-label="适应窗口" disabled={disabled} onClick={onFit}>适应</button>
    </div>
  );
}

"use client";

import { useRef } from "react";

import type { EditorAction } from "@/features/portal/editor/editor-types";
import type { PortalSceneV1 } from "@/features/portal/portal-scene";

export function LayerPanel({
  scene,
  selection,
  dispatch,
  onFocusElement,
}: {
  scene: PortalSceneV1;
  selection: string[];
  dispatch(action: EditorAction): void;
  onFocusElement(id: string): void;
}) {
  const draggingId = useRef<string | null>(null);
  const ordered = [...scene.elements].sort((left, right) =>
    right.zIndex - left.zIndex || left.id.localeCompare(right.id));

  return (
    <section aria-label="图层面板">
      <h2>图层</h2>
      <ul className="editor-layer-list">
        {ordered.map((element) => (
          <li
            key={element.id}
            data-testid={`layer-${element.id}`}
            draggable={!element.locked}
            aria-current={selection.includes(element.id) ? "true" : undefined}
            onDragStart={(event) => {
              draggingId.current = element.id;
              event.dataTransfer?.setData("text/plain", element.id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer?.getData("text/plain") || draggingId.current;
              draggingId.current = null;
              if (!id || id === element.id) return;
              dispatch({ type: "REORDER_ELEMENT", id, toIndex: element.zIndex });
            }}
          >
            <button
              type="button"
              className="editor-layer-select"
              aria-label={`选择 ${element.name}`}
              onClick={() => {
                dispatch({ type: "SELECT_ELEMENT", id: element.id, source: "LAYERS" });
                onFocusElement(element.id);
              }}
            >
              <span>{element.type}</span>
              <strong>{element.name}</strong>
            </button>
            <div className="editor-layer-actions">
              <button
                type="button"
                aria-label={`${element.hidden ? "显示" : "隐藏"} ${element.name}`}
                disabled={element.locked}
                onClick={() => dispatch({ type: "TOGGLE_ELEMENT_HIDDEN", id: element.id })}
              >
                {element.hidden ? "显示" : "隐藏"}
              </button>
              <button
                type="button"
                aria-label={`${element.locked ? "解锁" : "锁定"} ${element.name}`}
                onClick={() => dispatch({ type: "TOGGLE_ELEMENT_LOCKED", id: element.id })}
              >
                {element.locked ? "解锁" : "锁定"}
              </button>
              <button
                type="button"
                aria-label={`前移 ${element.name}`}
                disabled={element.locked || element.zIndex === scene.elements.length - 1}
                onClick={() => dispatch({ type: "REORDER_ELEMENT", id: element.id, direction: "FORWARD" })}
              >
                前移
              </button>
              <button
                type="button"
                aria-label={`后移 ${element.name}`}
                disabled={element.locked || element.zIndex === 0}
                onClick={() => dispatch({ type: "REORDER_ELEMENT", id: element.id, direction: "BACKWARD" })}
              >
                后移
              </button>
              <button
                type="button"
                aria-label={`置顶 ${element.name}`}
                disabled={element.locked || element.zIndex === scene.elements.length - 1}
                onClick={() => dispatch({
                  type: "REORDER_ELEMENT",
                  id: element.id,
                  toIndex: scene.elements.length - 1,
                })}
              >
                置顶
              </button>
              <button
                type="button"
                aria-label={`置底 ${element.name}`}
                disabled={element.locked || element.zIndex === 0}
                onClick={() => dispatch({ type: "REORDER_ELEMENT", id: element.id, toIndex: 0 })}
              >
                置底
              </button>
              <button
                type="button"
                aria-label={`删除 ${element.name}`}
                disabled={element.locked}
                onClick={() => dispatch({ type: "DELETE_ELEMENT", id: element.id })}
              >
                删除
              </button>
            </div>
          </li>
        ))}
        <li className="editor-background-layer">
          <span>BACKGROUND</span>
          <strong>背景</strong>
          <span>{scene.background.locked ? "已锁定" : "底层"}</span>
        </li>
      </ul>
    </section>
  );
}

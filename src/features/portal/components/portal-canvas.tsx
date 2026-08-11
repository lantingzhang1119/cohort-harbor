"use client";

import { useEffect, useRef, useState } from "react";

import { PortalViewport } from "@/generated/prisma/enums";
import { PORTAL_CANVAS_SIZES, PORTAL_MIN_ELEMENT_SIZE, type PortalElementInput } from "@/features/portal/portal-schemas";

export type PortalCanvasElement = PortalElementInput & { assetUrl: string };

type Gesture = {
  id: string;
  startX: number;
  startY: number;
  original: PortalCanvasElement;
  direction: "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
};

const handleLabels = {
  nw: "左上调整大小", n: "上方调整大小", ne: "右上调整大小", e: "右侧调整大小",
  se: "右下调整大小", s: "下方调整大小", sw: "左下调整大小", w: "左侧调整大小",
} as const;

export function PortalCanvas({
  viewport,
  elements,
  selectedId,
  onSelect,
  onChange,
  readOnly = false,
}: {
  viewport: PortalViewport | "DESKTOP" | "MOBILE";
  elements: PortalCanvasElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (elements: PortalCanvasElement[]) => void;
  readOnly?: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const size = PORTAL_CANVAS_SIZES[viewport];

  useEffect(() => {
    function pointerMove(event: PointerEvent) {
      if (!gesture) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const scaleX = rect?.width ? size.canvasWidth / rect.width : 1;
      const scaleY = rect?.height ? size.canvasHeight / rect.height : 1;
      const dx = Math.round((event.clientX - gesture.startX) * scaleX);
      const dy = Math.round((event.clientY - gesture.startY) * scaleY);
      const next = { ...gesture.original };
      if (gesture.direction === "move") {
        next.x = Math.min(size.canvasWidth - next.width, Math.max(0, gesture.original.x + dx));
        next.y = Math.min(size.canvasHeight - next.height, Math.max(0, gesture.original.y + dy));
      } else {
        const north = gesture.direction.includes("n");
        const south = gesture.direction.includes("s");
        const west = gesture.direction.includes("w");
        const east = gesture.direction.includes("e");
        if (west) {
          const x = Math.min(gesture.original.x + gesture.original.width - PORTAL_MIN_ELEMENT_SIZE, Math.max(0, gesture.original.x + dx));
          next.width = gesture.original.width + gesture.original.x - x;
          next.x = x;
        }
        if (east) next.width = Math.min(size.canvasWidth - gesture.original.x, Math.max(PORTAL_MIN_ELEMENT_SIZE, gesture.original.width + dx));
        if (north) {
          const y = Math.min(gesture.original.y + gesture.original.height - PORTAL_MIN_ELEMENT_SIZE, Math.max(0, gesture.original.y + dy));
          next.height = gesture.original.height + gesture.original.y - y;
          next.y = y;
        }
        if (south) next.height = Math.min(size.canvasHeight - gesture.original.y, Math.max(PORTAL_MIN_ELEMENT_SIZE, gesture.original.height + dy));
      }
      onChange(elements.map((element) => element.id === gesture.id ? next : element));
    }
    function pointerUp() { setGesture(null); }
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, [elements, gesture, onChange, size.canvasHeight, size.canvasWidth]);

  function startGesture(event: React.PointerEvent, element: PortalCanvasElement, direction: Gesture["direction"]) {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(element.id);
    setGesture({ id: element.id, startX: event.clientX, startY: event.clientY, original: { ...element }, direction });
  }

  return <div className={`portal-canvas-frame portal-canvas-frame--${viewport.toLowerCase()}`}>
    <div
      ref={canvasRef}
      className="portal-canvas"
      data-viewport={viewport}
      style={{ aspectRatio: `${size.canvasWidth} / ${size.canvasHeight}` }}
      onPointerDown={() => !readOnly && onSelect("")}
    >
      {[...elements].sort((left, right) => left.zIndex - right.zIndex).map((element) => {
        const selected = selectedId === element.id;
        return <div
          className={`portal-canvas-element${selected ? " is-selected" : ""}`}
          key={element.id}
          style={{
            transform: "translate3d(0, 0, 0)",
            left: `${(element.x / size.canvasWidth) * 100}%`,
            top: `${(element.y / size.canvasHeight) * 100}%`,
            width: `${(element.width / size.canvasWidth) * 100}%`,
            height: `${(element.height / size.canvasHeight) * 100}%`,
            zIndex: element.zIndex,
          }}
          onPointerDown={(event) => startGesture(event, element, "move")}
        >
          {/* Authenticated private assets are rendered semantically; layout is constrained data, never HTML. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={element.assetUrl} alt={element.altText} draggable={false} />
          {selected && !readOnly && Object.entries(handleLabels).map(([direction, label]) =>
            <button
              key={direction}
              type="button"
              className={`portal-resize-handle portal-resize-handle--${direction}`}
              aria-label={label}
              onPointerDown={(event) => startGesture(event, element, direction as Gesture["direction"])}
            />,
          )}
        </div>;
      })}
    </div>
  </div>;
}

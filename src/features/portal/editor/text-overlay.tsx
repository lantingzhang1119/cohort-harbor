"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PortalElement } from "@/features/portal/portal-scene";

type TextElement = Extract<PortalElement, { type: "TEXT" }>;

type StageContainer = {
  container(): HTMLElement;
};

export type TextOverlayProps = {
  element: TextElement;
  stage: StageContainer;
  zoom: number;
  onCommit(text: string): void;
  onCancel(): void;
};

export function TextOverlay({
  element,
  stage,
  zoom,
  onCommit,
  onCancel,
}: TextOverlayProps) {
  const [text, setText] = useState(element.text);
  const [stageBounds, setStageBounds] = useState(() =>
    stage.container().getBoundingClientRect());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const finishedRef = useRef(false);
  const composingRef = useRef(false);

  useLayoutEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  useLayoutEffect(() => {
    const updatePosition = () => {
      setStageBounds(stage.container().getBoundingClientRect());
    };
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    observer?.observe(stage.container());
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      observer?.disconnect();
    };
  }, [stage]);

  const commit = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCommit(text);
  }, [onCommit, text]);

  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  }, [onCancel]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <textarea
      ref={textareaRef}
      aria-label="编辑文字"
      value={text}
      maxLength={10_000}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onKeyDown={(event) => {
        if (
          composingRef.current
          || event.nativeEvent.isComposing
          || event.keyCode === 229
        ) {
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          commit();
        }
      }}
      style={{
        position: "fixed",
        zIndex: 1000,
        left: stageBounds.left + element.x * zoom,
        top: stageBounds.top + element.y * zoom,
        width: element.width * zoom,
        height: element.height * zoom,
        boxSizing: "content-box",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        resize: "none",
        border: 0,
        outline: "1px solid #2563EB",
        outlineOffset: 0,
        background: element.backgroundColor ?? "rgba(255, 255, 255, 0.94)",
        color: element.color,
        fontFamily: `"${element.fontFamily}", sans-serif`,
        fontSize: element.fontSize * zoom,
        fontWeight: element.fontWeight,
        fontStyle: element.italic ? "italic" : "normal",
        textDecoration: element.underline ? "underline" : "none",
        letterSpacing: element.letterSpacing * zoom,
        lineHeight: String(element.lineHeight),
        textAlign: element.align.toLowerCase() as "left" | "center" | "right",
        opacity: element.opacity,
        transform: `rotate(${element.rotation}deg)`,
        transformOrigin: "center center",
      }}
    />,
    document.body,
  );
}

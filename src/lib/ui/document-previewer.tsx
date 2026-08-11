"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { BackButton } from "@/lib/ui/back-button";
import { WatermarkOverlay } from "@/lib/ui/watermark-overlay";

type ZoomMode = "FIT_WIDTH" | "FIT_PAGE" | "CUSTOM";
export type PreviewFormat = "PDF" | "IMAGE" | "CSV" | "TEXT";

export type DocumentPreviewerProps = {
  fileUrl: string;
  previewFormat: PreviewFormat | null;
  watermarkName: string;
  watermarkOpacity?: number;
  backHref?: string;
  backLabel?: string;
  title?: string;
  policyId?: string;
  message?: string;
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function DocumentPreviewer({
  fileUrl,
  previewFormat,
  watermarkName,
  watermarkOpacity = 0.07,
  backHref,
  backLabel = "返回",
  title,
  policyId,
  message: externalMessage = "",
}: DocumentPreviewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => {
    if (typeof window === "undefined" || !policyId) return "FIT_WIDTH";
    const stored = sessionStorage.getItem(`policy-zoom-mode:${policyId}`);
    return stored === "FIT_WIDTH" || stored === "FIT_PAGE" || stored === "CUSTOM"
      ? stored
      : "FIT_WIDTH";
  });
  const [customZoom, setCustomZoom] = useState(1);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [textPreview, setTextPreview] = useState("");
  const [internalStatusMessage, setInternalStatusMessage] = useState("");
  const statusMessage = externalMessage || internalStatusMessage;

  useEffect(() => {
    if (policyId) {
      sessionStorage.setItem(`policy-zoom-mode:${policyId}`, zoomMode);
    }
  }, [policyId, zoomMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const update = () => setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [previewFormat]);

  useEffect(() => {
    if (!fileUrl || !previewFormat) return;

    if (previewFormat === "TEXT" || previewFormat === "CSV") {
      const controller = new AbortController();
      fetch(fileUrl, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error("文件加载失败");
          return response.text();
        })
        .then((text) => {
          setTextPreview(text);
          setInternalStatusMessage("");
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name !== "AbortError") {
            setInternalStatusMessage("文件加载失败");
          }
        });
      return () => controller.abort();
    }

    if (previewFormat === "IMAGE") {
      return;
    }

    if (previewFormat === "PDF") {
      import("pdfjs-dist")
        .then((pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url
          ).toString();
          return pdfjs.getDocument({ url: fileUrl, withCredentials: true }).promise;
        })
        .then((doc) => {
          documentRef.current = doc;
          setPages(doc.numPages);
          setInternalStatusMessage("");
        })
        .catch((error: unknown) => {
          setInternalStatusMessage(error instanceof Error ? error.message : "PDF 文件加载失败");
        });
    }
  }, [fileUrl, previewFormat]);

  useEffect(() => {
    const doc = documentRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || !containerSize.width || previewFormat !== "PDF") return;

    let cancelled = false;
    void doc.getPage(page).then(async (pdfPage) => {
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const padding = containerSize.width < 640 ? 12 : 40;
      const availableWidth = Math.max(240, containerSize.width - padding);
      const availableHeight = Math.max(320, containerSize.height - padding);
      const scale =
        zoomMode === "FIT_WIDTH"
          ? availableWidth / natural.width
          : zoomMode === "FIT_PAGE"
            ? Math.min(availableWidth / natural.width, availableHeight / natural.height)
            : customZoom;
      const viewport = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      renderTaskRef.current?.cancel();
      const renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      renderTaskRef.current = renderTask;
      try {
        await renderTask.promise;
        if (!cancelled) setInternalStatusMessage("");
      } finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
      }
    }).catch((error: unknown) => {
      if (!cancelled && (error as { name?: string }).name !== "RenderingCancelledException") {
        setInternalStatusMessage("当前页面渲染失败");
      }
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [containerSize, customZoom, page, pages, previewFormat, zoomMode]);

  const csvRows = useMemo(() => (previewFormat === "CSV" ? parseCsv(textPreview) : []), [previewFormat, textPreview]);

  const setCustomScale = (next: number) => {
    setCustomZoom(Math.max(0.4, Math.min(3, next)));
    setZoomMode("CUSTOM");
  };

  return (
    <main className="pdf-reader policy-reader document-previewer">
      <WatermarkOverlay name={watermarkName} opacity={watermarkOpacity} />
      <header className="document-previewer-header">
        <div className="document-previewer-nav">
          <BackButton href={backHref} label={backLabel} />
          {title && <h1 className="document-title">{title}</h1>}
        </div>
        {previewFormat === "PDF" && (
          <div className="pdf-controls" role="toolbar" aria-label="预览控制">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((val) => Math.max(1, val - 1))}
            >
              上一页
            </button>
            <span>{page} / {pages || "-"}</span>
            <button
              type="button"
              disabled={!pages || page >= pages}
              onClick={() => setPage((val) => Math.min(pages || 1, val + 1))}
            >
              下一页
            </button>
            <button type="button" onClick={() => setCustomScale(customZoom - 0.15)}>
              缩小
            </button>
            <button type="button" onClick={() => setCustomScale(customZoom + 0.15)}>
              放大
            </button>
            <button
              type="button"
              aria-pressed={zoomMode === "FIT_WIDTH"}
              onClick={() => setZoomMode("FIT_WIDTH")}
            >
              适合宽度
            </button>
            <button
              type="button"
              aria-pressed={zoomMode === "FIT_PAGE"}
              onClick={() => setZoomMode("FIT_PAGE")}
            >
              适合整页
            </button>
          </div>
        )}
      </header>

      {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}

      <section
        className={`pdf-canvas-wrap preview-${previewFormat?.toLowerCase() ?? "loading"}`}
        ref={containerRef}
      >
        {previewFormat === "PDF" && <canvas ref={canvasRef} />}
        {previewFormat === "IMAGE" && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={fileUrl} alt={title || "文档图片预览"} />
        )}
        {previewFormat === "TEXT" && <pre className="policy-text-preview">{textPreview}</pre>}
        {previewFormat === "CSV" && (
          <div className="policy-csv-preview">
            <table>
              <tbody>
                {csvRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) =>
                      rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { DocumentPreviewer, type PreviewFormat } from "@/lib/ui/document-previewer";

export function PolicyViewer({ policyId }: { policyId: string }) {
  const [format, setFormat] = useState<PreviewFormat | null>(null);
  const [watermarkName, setWatermarkName] = useState("");
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.07);
  const [message, setMessage] = useState("正在打开制度文件…");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/policies", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: {
        policies?: Array<{ id: string; versions: Array<{ previewFormat?: PreviewFormat }> }>;
        watermarkName?: string;
        watermarkOpacity?: number;
      }) => {
        const nextFormat = result.policies?.find((policy) => policy.id === policyId)?.versions[0]?.previewFormat;
        if (!nextFormat) throw new Error("制度预览尚未就绪");
        setFormat(nextFormat);
        setWatermarkName(result.watermarkName ?? "");
        setWatermarkOpacity(result.watermarkOpacity ?? 0.07);
        setMessage("");
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setMessage(error instanceof Error ? error.message : "制度预览加载失败");
        }
      });
    return () => controller.abort();
  }, [policyId]);

  return (
    <DocumentPreviewer
      fileUrl={`/api/policies/${policyId}/content`}
      previewFormat={format}
      watermarkName={watermarkName}
      watermarkOpacity={watermarkOpacity}
      backHref="/employee/policies"
      backLabel="← 返回制度列表"
      policyId={policyId}
      message={message}
    />
  );
}

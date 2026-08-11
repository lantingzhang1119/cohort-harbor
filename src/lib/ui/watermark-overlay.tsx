import React from "react";
import { Watermark } from "@/lib/ui/watermark";

export type WatermarkOverlayProps = {
  name: string;
  opacity?: number;
  children?: React.ReactNode;
  className?: string;
};

export function WatermarkOverlay({
  name,
  opacity = 0.07,
  children,
  className = "",
}: WatermarkOverlayProps) {
  return (
    <div className={`watermark-overlay-wrapper ${className}`.trim()} style={{ position: "relative" }}>
      <Watermark name={name} opacity={opacity} />
      {children}
    </div>
  );
}

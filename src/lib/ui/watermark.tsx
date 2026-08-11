import { BRAND } from "@/lib/brand";

export function Watermark({ name, opacity = 0.07 }: { name: string; opacity?: number }) {
  const safeOpacity = Math.min(0.18, Math.max(0.03, opacity));
  return (
    <div className="watermark-layer" aria-hidden="true" style={{ opacity: safeOpacity }}>
      {Array.from({ length: 24 }, (_, index) => (
        <span key={index}>{name} · {BRAND.name}</span>
      ))}
    </div>
  );
}

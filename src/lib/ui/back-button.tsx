import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import React from "react";

export type BackButtonProps = {
  href?: string;
  label?: string;
  onClick?: () => void;
  className?: string;
};

export function BackButton({ href, label = "返回", onClick, className = "" }: BackButtonProps) {
  const text = label.startsWith("←") ? label : `← ${label}`;
  const combinedClassName = `back-button ${className}`.trim();

  if (href) {
    return (
      <Link href={href} className={combinedClassName}>
        <ArrowLeft aria-hidden="true" className="w-4 h-4" />
        <span>{text}</span>
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={combinedClassName}>
      <ArrowLeft aria-hidden="true" className="w-4 h-4" />
      <span>{text}</span>
    </button>
  );
}

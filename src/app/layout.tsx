import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/noto-sans-sc";
import "./globals.css";

import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name}${BRAND.platformName}`,
    template: `%s｜${BRAND.name}`,
  },
  description: `面向${BRAND.name}员工的本地入职指南、制度学习与考试平台。`,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

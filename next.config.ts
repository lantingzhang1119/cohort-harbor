import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // PDF.js and Tesseract resolve Node workers relative to their installed packages.
  // Bundling either into .next/server/chunks breaks those worker paths at runtime.
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist", "tesseract.js"],
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
};

export default nextConfig;

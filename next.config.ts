import type { NextConfig } from "next";

// A GitHub Pages project site is served from /<repo>, not from the domain root,
// so every asset URL needs that prefix — including the worker's WASM, which is
// fetched by hand (see workers/cad.worker.ts). Both knobs are off by default:
// `next dev` and `next build && next start` keep working as before, and only
// `npm run build:pages` (what CI runs) turns the export on. Empty basePath is
// also what a custom domain would want.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_OUTPUT === "export" ? { output: "export" as const } : {}),
  basePath,
  // No image optimizer on a static host; nothing here uses next/image anyway.
  images: { unoptimized: true },
};

export default nextConfig;

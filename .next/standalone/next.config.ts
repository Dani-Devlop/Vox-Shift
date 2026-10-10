import type { NextConfig } from "next";

// STATIC_EXPORT=1 → GitHub Pages build: pure client-side static demo.
// (API routes + socket.io engine are removed for that build — the UI then
// honestly reports the engine as offline. Local/dev keeps standalone mode.)
const isStaticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isStaticExport
    ? {
        output: "export" as const,
        basePath: "/Vox-Shift",
        images: { unoptimized: true },
      }
    : { output: "standalone" as const }),
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;

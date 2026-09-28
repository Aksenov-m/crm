import type { NextConfig } from "next";

const config: NextConfig = {
  output: process.env.NEXT_OUTPUT === "export" ? "export" : undefined,
  // Static hosts can serve /demo/index.html without extension rewrites.
  trailingSlash: true,
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: false,
  turbopack: { root: process.cwd() },
};

export default config;

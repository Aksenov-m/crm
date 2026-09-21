import type { NextConfig } from "next";

const config: NextConfig = {
  output: process.env.NEXT_OUTPUT === "export" ? "export" : undefined,
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
};

export default config;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Production runs as a self-contained container (see web/Dockerfile).
  output: "standalone",
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone only for the Docker image (web/Dockerfile sets DOCKER_BUILD).
  // Vercel does its own tracing and breaks on standalone output.
  ...(process.env.DOCKER_BUILD ? { output: "standalone" as const } : {}),
};

export default nextConfig;

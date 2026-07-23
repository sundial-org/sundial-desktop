import type { NextConfig } from "next";
import { fileURLToPath } from "url";

// Static export of the LOCAL desktop surface only (/local, /local/[projectId]).
// The desktop sidecar serves this build directly, so local work never depends
// on the cloud origin; all other routes keep proxying to the remote app.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  agentRules: false,
  devIndicators: false,
  images: { unoptimized: true },
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;

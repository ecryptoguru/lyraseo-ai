import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["@lyraseo/contracts", "@lyraseo/visibility", "@lyraseo/db"],
};

export default nextConfig;

import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "next/headers": new URL(
        "./apps/lyraseo-web/node_modules/next/headers.js",
        import.meta.url,
      ).pathname,
      "next/navigation": new URL(
        "./apps/lyraseo-web/node_modules/next/navigation.js",
        import.meta.url,
      ).pathname,
      "@": new URL("./apps/lyraseo-web/src", import.meta.url).pathname,
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/output/handoff-carrier-*/snapshot/**",
    ],
    env: {
      LYRA_ENABLED_CAPABILITIES:
        "audits,context,search,analytics,content,visibility,mcp,agency",
    },
    fileParallelism: false,
    hookTimeout: 15000,
    testTimeout: 15000,
  },
});

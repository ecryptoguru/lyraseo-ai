import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "external-handoffs.spec.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3012", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3012",
    url: "http://127.0.0.1:3012",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      LYRA_AUTH_ENABLED: "false",
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3012",
    },
  },
});

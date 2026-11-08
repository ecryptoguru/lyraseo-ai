import { defineConfig, devices } from "@playwright/test";
if (process.env.NO_COLOR !== undefined) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./tests",
  testMatch: "auth-recovery.spec.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3034", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3034",
    url: "http://127.0.0.1:3034",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      LYRA_AUTH_ENABLED: "false",
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3034",
    },
  },
});

import { defineConfig, devices } from "@playwright/test";
// Match the repository browser runner without changing application diagnostics.
if (process.env.NO_COLOR !== undefined) delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "./tests/agency-components",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30000,
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});

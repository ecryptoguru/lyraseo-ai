import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  use: { baseURL: "http://127.0.0.1:3016", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm start --port 3016",
    url: "http://127.0.0.1:3016",
    reuseExistingServer: false,
    timeout: 60000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    video: "off",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run app -- --host 127.0.0.1",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

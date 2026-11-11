import { defineConfig } from "@playwright/test";

// UI end-to-end tests run against a real room server started inside each test file.
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.test.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { headless: true },
});

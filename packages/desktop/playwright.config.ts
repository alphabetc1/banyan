import { defineConfig } from "@playwright/test";

// Desktop end-to-end tests launch the built Electron app against a real room server.
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.test.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});

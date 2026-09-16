import { defineConfig } from "@playwright/test";
import { assertElectronE2EAllowed } from "./tests/e2e/electron-launch-guard.js";

assertElectronE2EAllowed(process.platform, process.env);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
  },
});

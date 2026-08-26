import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: {
    index: resolve("apps/desktop/src/main/index.ts"),
    "agent-worker": resolve("apps/desktop/src/worker/index.ts"),
  } } } },
  preload: { build: { rollupOptions: { input: resolve("apps/desktop/src/preload/index.ts") } } },
  renderer: { root: "apps/desktop/src/renderer", plugins: [react()] },
});

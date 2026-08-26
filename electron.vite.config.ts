import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: {
    index: resolve("apps/desktop/src/main/index.ts"),
    "agent-worker": resolve("apps/desktop/src/worker/index.ts"),
  } } } },
  preload: { build: { rollupOptions: {
    input: resolve("apps/desktop/src/preload/index.ts"),
    output: { format: "cjs", entryFileNames: "[name].js" },
  } } },
  renderer: {
    root: resolve("apps/desktop/src/renderer"),
    build: { rollupOptions: { input: resolve("apps/desktop/src/renderer/index.html") } },
    plugins: [react()],
  },
});

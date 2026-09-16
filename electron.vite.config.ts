import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: {
    index: resolve("apps/desktop/src/main/index.ts"),
    "agent-worker": resolve("apps/desktop/src/worker/index.ts"),
    "profile-diagnose-cli": resolve("apps/desktop/src/main/profile-diagnose-cli.ts"),
  } } } },
  preload: { build: {
    // The preload runs sandboxed (sandbox: true) and cannot require
    // node_modules at runtime, so everything except electron must be bundled
    // (electron-vite would otherwise externalize deps like typebox).
    externalizeDeps: false,
    rollupOptions: {
    input: resolve("apps/desktop/src/preload/index.ts"),
    output: { format: "cjs", entryFileNames: "[name].js" },
    external: ["electron"],
  } } },
  renderer: {
    root: resolve("apps/desktop/src/renderer"),
    build: { rollupOptions: { input: resolve("apps/desktop/src/renderer/index.html") } },
    plugins: [react()],
  },
});

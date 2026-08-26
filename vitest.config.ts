import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
});

import { defineConfig } from "vitest/config";

// Live opt-in suite: ONLY explicit live tests (requires real provider keys).
// Never part of the default `npm test` run.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.live.test.ts"],
  },
});

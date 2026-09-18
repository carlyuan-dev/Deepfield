import { configDefaults, defineConfig } from "vitest/config";

// Live opt-in suite: ONLY explicit live tests (requires real provider keys).
// Never part of the default `npm test` run.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    globals: true,
    include: ["{apps,packages,scripts,tests}/**/*.live.test.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      "**/{dist,.superpowers,.worktrees,.pnpm-store,release,out,coverage,test-results,playwright-report,benchmark-results}/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
  },
});

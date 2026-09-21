import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    globals: true,
    maxWorkers: 2,
    include: ["{apps,packages,capabilities,scripts,tests}/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/{.superpowers,.worktrees,.pnpm-store,release,out,coverage,test-results,playwright-report,benchmark-results}/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "**/*.live.test.{ts,tsx}",
    ],
  },
});

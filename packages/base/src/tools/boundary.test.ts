import { expect, it } from "vitest";
import { build } from "esbuild";
import { ToolExecutionError, ToolExecutionResultSchema } from "./index.js";
import { ToolRunner, TraceBudgetPool } from "./runtime.js";
import { ToolExecutionError as LegacyError, ToolRunner as LegacyRunner } from "../../../tool-platform/src/index.js";
import { ToolExecutionResultSchema as LegacyResultSchema } from "../../../contracts/src/tools.js";
import { TraceBudgetPool as WorkerTraceBudgetPool } from "../../../../apps/desktop/src/worker/tools/tool-runtime.js";
import { createSearchWebDefinition } from "./web/index.js";
import { createSearchWebDefinition as LegacySearchDefinition } from "../../../retrieval/src/search-tool.js";

it("bundles Tools contracts for browsers without runtime or web dependencies", async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname], bundle: true, platform: "browser", write: false, metafile: true });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some(path => /tool-platform|retrieval|capability-sdk|pi-ai|pi-agent|\/search\/|\/runtime\.|\/runner\.|\/web\//.test(path))).toBe(false);
});

it("preserves one implementation and schema identity through legacy entry points", () => {
  expect(LegacyError).toBe(ToolExecutionError);
  expect(LegacyRunner).toBe(ToolRunner);
  expect(LegacyResultSchema).toBe(ToolExecutionResultSchema);
  expect(WorkerTraceBudgetPool).toBe(TraceBudgetPool);
  expect(LegacySearchDefinition).toBe(createSearchWebDefinition);
});

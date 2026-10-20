import { expect, it } from "vitest";
import { build } from "esbuild";
import { SearchProviderError } from "./index.js";
import { SearchProviderError as LegacyError } from "../../../retrieval/src/search-provider.js";

it("bundles the safe Search contract for browsers and retains legacy error identity", async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname], bundle: true, platform: "browser", write: false, metafile: true });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some(path => /retrieval|capability-sdk|tool-platform|cheerio|pdfjs|ipaddr|\/runtime\./.test(path))).toBe(false);
  expect(new LegacyError("cancelled")).toBeInstanceOf(SearchProviderError);
});

import { test } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { summarizeJsonShape } from "./metaso-shape.js";

/**
 * OPT-IN single-call MetaSo shape probe (runs only via the live vitest
 * config). Module load requires a non-blank key; the probe emits exactly one
 * value-free line METASO_RESPONSE_SHAPE_V1=<shape JSON> and persists nothing.
 * NEVER run inside the default suite.
 */
function requireKey(): string {
  const key = process.env.METASO_SEARCH_API_KEY;
  if (key === undefined || key.trim().length === 0) {
    throw new Error("METASO_SEARCH_API_KEY is required for the metaso shape probe");
  }
  return key;
}

const KEY = requireKey();

test("metaso shape probe: one POST, shape-only output, no value persistence", async () => {
  const query = "humanoid robot companies official website";
  const client = new ProviderHttpClient({
    transport: createNodeProviderTransport(),
    endpoint: { origin: "https://metaso.cn", pathPrefix: "/api/v1/search" },
    totalTimeoutMs: 15_000,
  });
  const response = await client.request({
    method: "POST",
    path: "/api/v1/search",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      q: query,
      scope: "webpage",
      size: 5,
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: true,
    }),
    signal: new AbortController().signal,
  });
  let payload: unknown;
  try {
    try {
      payload = JSON.parse(response.body.toString("utf8")) as unknown;
    } catch {
      throw new Error("metaso probe: malformed json response");
    }
    const shape = summarizeJsonShape(payload);
    const serialized = JSON.stringify(shape);
    // plain-if guard, never a matcher that prints the received value
    if (serialized.includes(KEY) || serialized.includes(query) || serialized.includes("http")) {
      throw new Error("metaso probe: unsafe shape output");
    }
    process.stdout.write(`METASO_RESPONSE_SHAPE_V1=${serialized}\n`);
  } finally {
    response.body.fill(0); // never leave the raw response in memory
  }
});

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  ProviderHttpClient,
  type ProviderTransport,
  type ProviderTransportResponse,
} from "../provider-http-client.js";
import { SearchProviderError } from "../search-provider.js";
import { createZhipuProvider, ZHIPU_ENDPOINT } from "./zhipu.js";

function jsonResponse(statusCode: number, body: unknown): ProviderTransportResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]),
    destroy() {},
  };
}

function scriptedTransport(script: Array<() => ProviderTransportResponse>) {
  let index = 0;
  const transport: ProviderTransport = {
    async request(_endpoint, _request) {
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error("no more scripted responses");
      }
      return next();
    },
  };
  return { transport };
}

function makeProvider(transport: ProviderTransport) {
  const client = new ProviderHttpClient({ transport, endpoint: ZHIPU_ENDPOINT });
  return createZhipuProvider({ client, token: "sk-z-boundary" });
}

async function boundaryError(body: unknown): Promise<SearchProviderError> {
  const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
  const provider = makeProvider(transport);
  try {
    await provider.search({ query: "humanoid robot", maxResults: 20 }, new AbortController().signal);
  } catch (error) {
    return error as SearchProviderError;
  }
  throw new Error("expected a rejection");
}

describe("zhipu response type boundaries (focused revision)", () => {
  it("rejects non-object JSON roots with stable malformed_response (never native TypeErrors)", async () => {
    for (const root of [null, 42, "plain", true]) {
      const error = await boundaryError(root);
      expect(error).toBeInstanceOf(SearchProviderError);
      expect(error.code).toBe("malformed_response");
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("TypeError");
      expect(String(error)).not.toContain("plain");
    }
    const arrayError = await boundaryError([{ search_result: [] }]);
    expect(arrayError.code).toBe("malformed_response");
  });

  it("rejects null/array/primitive entries inside search_result", async () => {
    const nullError = await boundaryError({ search_result: [null] });
    expect(nullError).toBeInstanceOf(SearchProviderError);
    expect(nullError.code).toBe("malformed_response");
    expect(nullError.cause).toBeUndefined();
    expect(String(nullError)).not.toContain("TypeError");

    expect((await boundaryError({ search_result: [["nested"]] })).code).toBe("malformed_response");
    expect((await boundaryError({ search_result: [42] })).code).toBe("malformed_response");
    expect((await boundaryError({ search_result: ["just-a-string"] })).code).toBe("malformed_response");
    expect(
      (await boundaryError({ search_result: [{ title: "A", link: "https://a.example/", content: "ok" }, null] })).code,
    ).toBe("malformed_response");
  });

  it("never leaks the raw payload or the bearer token in boundary errors", async () => {
    const error = await boundaryError({ search_result: [null], request_id: "req-9", extra: "sk-z-payload-secret" });
    const message = String(error);
    expect(message).not.toContain("sk-z-payload-secret");
    expect(message).not.toContain("sk-z-boundary");
    expect(message).not.toContain("req-9");
    expect(message).not.toContain("TypeError");
    expect(error.code).toBe("malformed_response");
  });
});

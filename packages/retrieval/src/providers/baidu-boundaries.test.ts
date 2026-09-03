import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  ProviderHttpClient,
  type ProviderTransport,
  type ProviderTransportResponse,
} from "../provider-http-client.js";
import { SearchProviderError } from "../search-provider.js";
import { BAIDU_ENDPOINT, createBaiduProvider } from "./baidu.js";

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
  const client = new ProviderHttpClient({ transport, endpoint: BAIDU_ENDPOINT });
  return createBaiduProvider({ client, token: "sk-ba-test", authHeader: "authorization" });
}

async function boundaryError(body: unknown): Promise<SearchProviderError> {
  const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
  const provider = makeProvider(transport);
  try {
    await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
  } catch (error) {
    return error as SearchProviderError;
  }
  throw new Error("expected a rejection");
}

describe("baidu response type boundaries (focused revision)", () => {
  it("rejects non-object JSON roots with stable malformed_response (never native TypeErrors)", async () => {
    for (const root of [null, 42, "plain", true]) {
      const error = await boundaryError(root);
      expect(error).toBeInstanceOf(SearchProviderError);
      expect(error.code).toBe("malformed_response");
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("plain");
      expect(String(error)).not.toContain("TypeError");
    }
    // array root is also not a valid payload object
    const arrayError = await boundaryError([{ references: [] }]);
    expect(arrayError.code).toBe("malformed_response");
  });

  it("rejects null/array/primitive entries inside references (stable malformed_response)", async () => {
    const nullError = await boundaryError({ references: [null] });
    expect(nullError).toBeInstanceOf(SearchProviderError);
    expect(nullError.code).toBe("malformed_response");
    expect(nullError.cause).toBeUndefined();
    expect(String(nullError)).not.toContain("TypeError");

    const arrayEntry = await boundaryError({ references: [["nested"]] });
    expect(arrayEntry.code).toBe("malformed_response");

    const primitiveEntry = await boundaryError({ references: ["just-a-string"] });
    expect(primitiveEntry.code).toBe("malformed_response");

    const mixedError = await boundaryError({
      references: [
        { title: "A", url: "https://a.example/", snippet: "ok" },
        null,
        { title: "C", url: "https://c.example/", snippet: "s" },
      ],
    });
    expect(mixedError.code).toBe("malformed_response");
  });

  it("never leaks the raw payload, entry values or the bearer token in boundary errors", async () => {
    // an invalid payload carrying a test secret must produce a stable error
    const invalidError = await boundaryError({ references: [null], extra: "sk-payload-secret" });
    const message = String(invalidError);
    expect(message).not.toContain("sk-payload-secret");
    expect(message).not.toContain("TypeError");
    expect(message).not.toContain("sk-ba-test");
    expect(invalidError.code).toBe("malformed_response");
    expect(invalidError.cause).toBeUndefined();
  });
});

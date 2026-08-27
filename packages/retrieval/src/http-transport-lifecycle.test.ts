import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { TransportError, createSafeHttpTransport, type TransportResponse } from "./http-transport.js";
import { adapterFor, fetchOptions, policy } from "./transport-test-helpers.js";

describe("safe http transport lifecycle hardening (focused revision)", () => {
  function destroyCountingResponse(
    statusCode: number,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): TransportResponse & { destroyCalls(): number } {
    let destroyed = false;
    let destroyCalls = 0;
    return {
      statusCode,
      headers,
      body: Readable.from(body ?? []),
      destroyCalls: () => destroyCalls,
      destroy() {
        // production destroy() is idempotent; count unique cleanup events
        if (!destroyed) {
          destroyed = true;
          destroyCalls += 1;
        }
      },
    };
  }

  it("destroys every redirect response before the next hop and on redirect failures", async () => {
    const responses = [
      destroyCountingResponse(302, { location: "http://example.com/b" }),
      destroyCountingResponse(302, { location: "http://example.com/c" }),
      destroyCountingResponse(200, { "content-type": "text/html" }, Buffer.from("final")),
    ];
    let cursor = 0;
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return responses[cursor++]!;
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const result = await transport.fetch("http://example.com/a", fetchOptions());
    expect(result.finalUrl).toBe("http://example.com/c");
    expect(responses[0]!.destroyCalls()).toBe(1);
    expect(responses[1]!.destroyCalls()).toBe(1);

    // missing location: the response is destroyed on the failure path
    const missing = destroyCountingResponse(302, {});
    const adapter2 = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return missing;
      },
    };
    const transport2 = createSafeHttpTransport({ policy: policy(), adapter: adapter2, maxBodyBytes: 1024 });
    await expect(transport2.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect/);
    expect(missing.destroyCalls()).toBe(1);
  });

  it("maps invalid Location URL parse to redirect_blocked and destroys the response", async () => {
    const response = destroyCountingResponse(302, { location: "http://[" });
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return response;
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect/);
    expect(response.destroyCalls()).toBe(1);
  });

  it("destroys the HEAD response body without buffering", async () => {
    const response = destroyCountingResponse(200, { "content-type": "text/html" }, Buffer.from("secret-body"));
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return response;
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const result = await transport.fetch("http://example.com/", { ...fetchOptions(), method: "HEAD" });
    expect(result.body.length).toBe(0);
    expect(response.destroyCalls()).toBe(1); // HEAD discards the would-be body
  });

  it("rejects malformed content-length values safely", async () => {
    for (const bad of [["12", "13"], "-5", "abc", "12.5", "1e3"]) {
      const response = destroyCountingResponse(200, { "content-length": bad as never, "content-type": "text/html" }, Buffer.from("x"));
      const adapter = {
        requests: [] as never[],
        async request(): Promise<TransportResponse> {
          return response;
        },
      };
      const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
      await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toBeInstanceOf(TransportError);
      expect(response.destroyCalls()).toBe(1);
    }
  });

  it("only shrinks the per-call maxBodyBytes against the constructor hard max", async () => {
    // constructor hard max 100; caller asks for 1000; a 101-byte body must still be rejected
    const response = destroyCountingResponse(200, { "content-type": "text/html" }, Buffer.from("x".repeat(101)));
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return response;
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 100 });
    await expect(
      transport.fetch("http://example.com/", { ...fetchOptions(), maxBodyBytes: 1000 }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(response.destroyCalls()).toBe(1);
  });

  it("validates constructor options and invalid per-call caps fail closed", async () => {
    expect(() => createSafeHttpTransport({ policy: policy(), adapter: adapterFor([]), maxBodyBytes: -1 })).toThrow(/maxBodyBytes/);
    expect(() => createSafeHttpTransport({ policy: policy(), adapter: adapterFor([]), maxBodyBytes: 1024, connectTimeoutMs: 0 })).toThrow(/connectTimeoutMs/);
    expect(() => createSafeHttpTransport({ policy: policy(), adapter: adapterFor([]), maxBodyBytes: 1024, totalTimeoutMs: NaN })).toThrow(/totalTimeoutMs/);
    expect(() => createSafeHttpTransport({ policy: policy(), adapter: adapterFor([]), maxBodyBytes: 1024, maxRedirects: -1 })).toThrow(/maxRedirects/);
    const transport = createSafeHttpTransport({ policy: policy(), adapter: adapterFor([]), maxBodyBytes: 100 });
    await expect(transport.fetch("http://example.com/", { ...fetchOptions(), maxBodyBytes: -5 })).rejects.toThrow(/blocked/);
    await expect(transport.fetch("http://example.com/", { ...fetchOptions(), maxBodyBytes: Infinity })).rejects.toThrow(/blocked/);
  });

  it("settles via the total deadline even when the adapter ignores the signal", async () => {
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        await new Promise<void>(() => {}); // never settles, ignores abort
        return destroyCountingResponse(200, {}, Buffer.from("x"));
      },
    };
    const transport = createSafeHttpTransport({
      policy: policy(),
      adapter,
      maxBodyBytes: 1024,
      totalTimeoutMs: 100,
      timer: () => ({ promise: new Promise<void>((resolve) => setTimeout(resolve, 10)), cancel: () => {} }),
    });
    await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/timeout/);
  });

  it("gives the caller abort precedence over the deadline", async () => {
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        await new Promise<void>(() => {});
        return destroyCountingResponse(200, {}, Buffer.from("x"));
      },
    };
    const transport = createSafeHttpTransport({
      policy: policy(),
      adapter,
      maxBodyBytes: 1024,
      totalTimeoutMs: 100,
      timer: () => ({ promise: new Promise<void>((resolve) => setTimeout(resolve, 5)), cancel: () => {} }),
    });
    const controller = new AbortController();
    const fetch = transport.fetch("http://example.com/", { signal: controller.signal });
    controller.abort(); // aborts before the 5ms deadline fires
    await expect(fetch).rejects.toThrow(/cancelled/);
  });
});

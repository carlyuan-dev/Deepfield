import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { gzipSync, deflateSync } from "node:zlib";
import {
  createSafeHttpTransport,
  TransportError,
  type TransportAdapter,
  type TransportResponse,
} from "./http-transport.js";
import { UrlPolicy, type DnsAnswer, type DnsLookup } from "./url-policy.js";

const PUBLIC_V4: DnsAnswer = { address: "93.184.216.34", family: 4 };
const lookup: DnsLookup = async () => [PUBLIC_V4];

function policy(): UrlPolicy {
  return new UrlPolicy({ lookup });
}

function fetchOptions(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

function adapterFor(script: Array<(request: { path: string; headers: Record<string, string> }) => TransportResponse>): TransportAdapter & { requests: Array<{ path: string; headers: Record<string, string>; addresses: readonly DnsAnswer[]; method: string }> } {
  const requests: Array<{ path: string; headers: Record<string, string>; addresses: readonly DnsAnswer[]; method: string }> = [];
  let index = 0;
  return {
    requests,
    async request(target, options, addresses) {
      const entry = { path: target.path, headers: options.headers, addresses, method: target.method };
      requests.push(entry);
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new TransportError("network_unavailable");
      }
      return next(entry);
    },
  };
}

function htmlResponse(body: string | Buffer, extraHeaders: Record<string, string | string[]> = {}): TransportResponse {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
    body: Readable.from([buffer]),
    destroy() {},
  };
}

function redirectResponse(location: string, statusCode = 302): TransportResponse {
  return {
    statusCode,
    headers: { location },
    body: Readable.from([]),
    destroy() {},
  };
}

describe("safe http transport", () => {
  it("issues GET with only transport-generated allowlisted headers", async () => {
    const adapter = adapterFor([(entry) => htmlResponse("<html>ok</html>")]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const result = await transport.fetch("http://example.com/page", fetchOptions());
    expect(result.statusCode).toBe(200);
    expect(result.body.toString("utf8")).toBe("<html>ok</html>");
    const headers = adapter.requests[0]!.headers;
    expect(Object.keys(headers)).toEqual(["user-agent", "accept", "accept-encoding"]);
    expect(JSON.stringify(headers)).not.toMatch(/cookie|authorization|proxy-authorization/i);
    expect(adapter.requests[0]!.addresses).toEqual([PUBLIC_V4]);
  });

  it("supports HEAD and rejects other methods", async () => {
    const adapter = adapterFor([() => ({ statusCode: 200, headers: {}, body: Readable.from([]), destroy() {} })]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const head = await transport.fetch("http://example.com/", { ...fetchOptions(), method: "HEAD" });
    expect(head.body.length).toBe(0);
    await expect(
      transport.fetch("http://example.com/", { ...fetchOptions(), method: "POST" as never }),
    ).rejects.toThrow(/blocked/);
  });

  it("blocks sensitive headers and revalidates every redirect with the policy", async () => {
    const adapter = adapterFor([
      () => redirectResponse("http://example.com/next"),
      () => redirectResponse("http://example.com/final"),
      () => htmlResponse("done"),
    ]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const result = await transport.fetch("http://example.com/start", fetchOptions());
    expect(result.finalUrl).toBe("http://example.com/final");
    expect(adapter.requests).toHaveLength(3);
    for (const request of adapter.requests) {
      expect(JSON.stringify(request.headers)).not.toMatch(/cookie|authorization|proxy-authorization/i);
    }
  });

  it("fails redirect_blocked on missing/oversized/unsupported redirect location and on exceeded hops", async () => {
    const missing = adapterFor([() => ({ statusCode: 302, headers: {}, body: Readable.from([]), destroy() {} })]);
    const transport1 = createSafeHttpTransport({ policy: policy(), adapter: missing, maxBodyBytes: 1024 });
    await expect(transport1.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect/);

    const huge = adapterFor([() => redirectResponse("http://example.com/" + "a".repeat(3000))]);
    const transport2 = createSafeHttpTransport({ policy: policy(), adapter: huge, maxBodyBytes: 1024 });
    await expect(transport2.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect/);

    const unsupportedCode = adapterFor([() => redirectResponse("http://example.com/x", 300)]);
    const transport3 = createSafeHttpTransport({ policy: policy(), adapter: unsupportedCode, maxBodyBytes: 1024 });
    await expect(transport3.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect|blocked/);

    const loop = adapterFor(Array.from({ length: 8 }, () => () => redirectResponse("http://example.com/x")));
    const transport4 = createSafeHttpTransport({ policy: policy(), adapter: loop, maxBodyBytes: 1024, maxRedirects: 5 });
    await expect(transport4.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/redirect/);
  });

  it("rejects a redirect target blocked by the policy", async () => {
    const adapter = adapterFor([() => redirectResponse("http://127.0.0.1/steal")]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/blocked/);
  });

  it("pre-checks content-length and streams identity bodies within bounds", async () => {
    const over = adapterFor([() => htmlResponse("x".repeat(10), { "content-length": "10" })]);
    const transport1 = createSafeHttpTransport({ policy: policy(), adapter: over, maxBodyBytes: 5 });
    await expect(transport1.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/too large/);

    const ok = adapterFor([() => htmlResponse("12345")]);
    const transport2 = createSafeHttpTransport({ policy: policy(), adapter: ok, maxBodyBytes: 5 });
    const result = await transport2.fetch("http://example.com/", fetchOptions());
    expect(result.body.toString()).toBe("12345");
  });

  it("counts decompressed bytes and destroys immediately on overrun (gzip/deflate/identity)", async () => {
    const bomb = gzipSync(Buffer.from("x".repeat(1000), "utf8"));
    let destroyed = false;
    const gzAdapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return {
          statusCode: 200,
          headers: { "content-encoding": "gzip" },
          body: Readable.from([bomb]),
          destroy() {
            destroyed = true;
          },
        };
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter: gzAdapter, maxBodyBytes: 100 });
    await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/too large/);
    expect(destroyed).toBe(true);

    const deflateBomb = deflateSync(Buffer.from("y".repeat(1000), "utf8"));
    const deflateAdapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return {
          statusCode: 200,
          headers: { "content-encoding": "deflate" },
          body: Readable.from([deflateBomb]),
          destroy() {},
        };
      },
    };
    const transport2 = createSafeHttpTransport({ policy: policy(), adapter: deflateAdapter, maxBodyBytes: 100 });
    await expect(transport2.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/too large/);
  });

  it("fails safely on unsupported or malformed content-encoding", async () => {
    const adapter = adapterFor([
      () => ({ statusCode: 200, headers: { "content-encoding": "br" }, body: Readable.from([]), destroy() {} }),
    ]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    await expect(transport.fetch("http://example.com/", fetchOptions())).rejects.toThrow(/unsupported/i);
  });

  it("enforces the total deadline across DNS, redirects and reads", async () => {
    let gateResolve!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const hangingAdapter = {
      requests: [] as never[],
      async request(
        _target: never,
        options: { signal: AbortSignal },
      ): Promise<TransportResponse> {
        await Promise.race([
          gate,
          new Promise<void>((_, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        ]);
        return { statusCode: 200, headers: {}, body: Readable.from([]), destroy() {} };
      },
    };
    const transport = createSafeHttpTransport({
      policy: policy(),
      adapter: hangingAdapter,
      maxBodyBytes: 1024,
      totalTimeoutMs: 100,
      timer: () => ({ promise: new Promise<void>((resolve) => setTimeout(resolve, 10)), cancel: () => {} }),
    });
    const fetch = transport.fetch("http://example.com/", fetchOptions());
    await expect(fetch).rejects.toThrow(/timeout/);
    gateResolve();
  });

  it("returns cancelled for pre-aborted and mid-flight aborts and destroys resources", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const adapter = adapterFor([]);
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    await expect(transport.fetch("http://example.com/", { signal: preAborted.signal })).rejects.toThrow(/cancelled/);
    expect(adapter.requests).toHaveLength(0);

    let destroyed = false;
    const neverEndingBody = new Readable({
      read() {
        // never ends until destroyed
      },
    });
    const midAdapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        return {
          statusCode: 200,
          headers: {},
          body: neverEndingBody,
          destroy() {
            destroyed = true;
            neverEndingBody.destroy();
          },
        };
      },
    };
    const controller = new AbortController();
    const transport2 = createSafeHttpTransport({ policy: policy(), adapter: midAdapter, maxBodyBytes: 1024 });
    const fetch2 = transport2.fetch("http://example.com/", { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 5)); // let the request start reading
    controller.abort();
    await expect(fetch2).rejects.toThrow(/cancelled/);
    expect(destroyed).toBe(true);
  });

  it("never leaks the URL, body or raw exception into error messages", async () => {
    const adapter = {
      requests: [] as never[],
      async request(): Promise<TransportResponse> {
        throw new Error("ECONNREFUSED 10.9.9.9 body-marker-secret");
      },
    };
    const transport = createSafeHttpTransport({ policy: policy(), adapter, maxBodyBytes: 1024 });
    const error = await transport.fetch("http://example.com/x", fetchOptions()).catch((caught) => caught);
    expect(String(error)).not.toMatch(/10\.9\.9\.9|body-marker-secret|example\.com|ECONNREFUSED/i);
    expect(error).toBeInstanceOf(TransportError);
  });
});

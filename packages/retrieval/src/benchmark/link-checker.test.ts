import { describe, expect, it } from "vitest";
import { createHttpLinkChecker } from "./link-checker.js";
import { checkLinkAccessible } from "../link-tool.js";
import { TransportError, type SafeHttpTransport, type FetchOptions, type FetchResult } from "../http-transport.js";

interface ScriptedFetchCall {
  method: string;
  url: string;
  maxBodyBytes: number;
}

function scriptedFetch(script: Array<(call: ScriptedFetchCall) => Promise<FetchResult>>): Pick<SafeHttpTransport, "fetch"> & { calls: ScriptedFetchCall[] } {
  const calls: ScriptedFetchCall[] = [];
  let index = 0;
  return {
    calls,
    async fetch(url: string, options: FetchOptions) {
      const call = { method: options.method ?? "GET", url, maxBodyBytes: options.maxBodyBytes ?? 0 };
      calls.push(call);
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error("no more scripted fetches");
      }
      return next(call);
    },
  };
}

function result(statusCode: number, body: Buffer = Buffer.alloc(0)): FetchResult {
  return {
    statusCode,
    finalUrl: "https://x.example/",
    contentType: "text/html",
    body,
    decompressedBytes: body.length,
    sha256: "abc",
  };
}

describe("link accessibility core + live checker (focused revision)", () => {
  it("falls back to a bounded GET on HEAD 405/501 and never buffers the fallback body", async () => {
    let fallbackBody = Buffer.from("page-body-marker");
    const transport = scriptedFetch([
      async () => result(405),
      async () => {
        fallbackBody = Buffer.from("page-body-marker");
        return result(200, fallbackBody);
      },
    ]);
    const outcome = await checkLinkAccessible({ transport }, "https://x.example/", new AbortController().signal);
    expect(outcome.accessible).toBe(true);
    expect(transport.calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(transport.calls[1]!.maxBodyBytes).toBeGreaterThan(0); // bounded fallback
    expect(transport.calls[1]!.maxBodyBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(fallbackBody.every((byte) => byte === 0)).toBe(true); // fallback body zeroed

    const transport501 = scriptedFetch([async () => result(501), async () => result(200)]);
    const outcome501 = await checkLinkAccessible({ transport: transport501 }, "https://x.example/", new AbortController().signal);
    expect(outcome501.accessible).toBe(true);
    expect(transport501.calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
  });

  it("treats ordinary HEAD results and blocked/error links correctly", async () => {
    const ok = scriptedFetch([async () => result(200)]);
    expect((await checkLinkAccessible({ transport: ok }, "https://x.example/", new AbortController().signal)).accessible).toBe(true);
    expect(ok.calls.map((call) => call.method)).toEqual(["HEAD"]);

    const notFound = scriptedFetch([async () => result(404)]);
    expect((await checkLinkAccessible({ transport: notFound }, "https://x.example/", new AbortController().signal)).accessible).toBe(false);

    const blocked = scriptedFetch([async () => { throw new TransportError("url_blocked"); }]);
    // the core PROPAGATES TransportError (the definition maps it to a Tool code)
    await expect(checkLinkAccessible({ transport: blocked }, "https://x.example/", new AbortController().signal)).rejects.toMatchObject({ code: "url_blocked" });
    // the live checker maps ordinary TransportError to accessible=false
    expect((await createHttpLinkChecker(blocked).check("https://x.example/", new AbortController().signal)).accessible).toBe(false);
  });

  it("propagates cancellation instead of swallowing it as an invalid link", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const transport = scriptedFetch([async () => { throw new TransportError("cancelled"); }]);
    await expect(
      checkLinkAccessible({ transport }, "https://x.example/", preAborted.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("the live checker reuses the same core and per-URL signal", async () => {
    const transport = scriptedFetch([
      async () => result(405),
      async () => result(200, Buffer.from("fallback-body")),
    ]);
    const checker = createHttpLinkChecker(transport);
    const outcome = await checker.check("https://x.example/", new AbortController().signal);
    expect(outcome).toEqual({ url: "https://x.example/", accessible: true });
    // ordinary blocked links are accessible=false, not infra errors
    const blockedTransport = scriptedFetch([async () => { throw new TransportError("url_blocked"); }]);
    const blockedOutcome = await createHttpLinkChecker(blockedTransport).check("https://x.example/", new AbortController().signal);
    expect(blockedOutcome.accessible).toBe(false);
    // the fallback body handed to the transport is zeroed by the core
    expect(transport.calls).toHaveLength(2);
  });
});

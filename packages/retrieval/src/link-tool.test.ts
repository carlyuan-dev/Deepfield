import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { ToolExecutionError } from "@deepfield/tool-platform";
import { createCheckLinkAccessibilityDefinition, MAX_LINK_FALLBACK_BYTES } from "./link-tool.js";
import { htmlResponse, makeTransport, scriptedAdapter } from "./transport-test-helpers.js";

function headResponse(statusCode: number, contentType = "text/html"): { statusCode: number; headers: Record<string, string>; body: Readable; destroy(): void } {
  return {
    statusCode,
    headers: { "content-type": contentType },
    body: Readable.from([]),
    destroy() {},
  };
}

describe("check_link_accessibility definition", () => {
  it("issues HEAD first and never buffers the head body", async () => {
    const adapter = scriptedAdapter([() => headResponse(200)]);
    const transport = makeTransport(adapter);
    const definition = createCheckLinkAccessibilityDefinition({ transport });
    const result = await definition.execute(
      { url: "https://example.com/link" },
      { traceId: "t", actor: "main_agent", toolSet: new (await import("@deepfield/tool-platform")).ToolSet([]) },
      new AbortController().signal,
      () => {},
    );
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.method).toBe("HEAD");
    expect(result).toMatchObject({ statusCode: 200, accessible: true });
    expect(JSON.stringify(result)).not.toContain("body");
  });

  it("falls back to a bounded GET only for 405/501 and discards the fallback body", async () => {
    const fallbackBody = "x".repeat(10);
    for (const status of [405, 501]) {
      const adapter = scriptedAdapter([
        () => headResponse(status),
        () => htmlResponse(`<html>${fallbackBody}</html>`),
      ]);
      const transport = makeTransport(adapter, { maxBodyBytes: MAX_LINK_FALLBACK_BYTES });
      const definition = createCheckLinkAccessibilityDefinition({ transport });
      const result = await definition.execute(
        { url: "https://example.com/link" },
        { traceId: "t", actor: "main_agent", toolSet: new (await import("@deepfield/tool-platform")).ToolSet([]) },
        new AbortController().signal,
        () => {},
      );
      expect(adapter.requests.map((request) => request.method)).toEqual(["HEAD", "GET"]);
      expect(JSON.stringify(result)).not.toContain(fallbackBody);
      expect(result.statusCode).toBe(200);
    }
  });

  it("reports non-2xx/3xx as inaccessible without a fallback", async () => {
    const adapter = scriptedAdapter([() => headResponse(404)]);
    const transport = makeTransport(adapter);
    const definition = createCheckLinkAccessibilityDefinition({ transport });
    const result = await definition.execute(
      { url: "https://example.com/missing" },
      { traceId: "t", actor: "main_agent", toolSet: new (await import("@deepfield/tool-platform")).ToolSet([]) },
      new AbortController().signal,
      () => {},
    );
    expect(adapter.requests).toHaveLength(1);
    expect(result).toMatchObject({ statusCode: 404, accessible: false });
  });

  it("maps policy/transport failures to stable tool codes", async () => {
    const blocked = {
      requests: [] as never[],
      async request() {
        throw new Error("raw socket error 10.0.0.1 marker");
      },
    };
    const transport = makeTransport(blocked as never);
    const definition = createCheckLinkAccessibilityDefinition({ transport });
    await expect(
      definition.execute(
        { url: "https://example.com/" },
        { traceId: "t", actor: "main_agent", toolSet: new (await import("@deepfield/tool-platform")).ToolSet([]) },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

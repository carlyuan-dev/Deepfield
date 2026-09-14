import { describe, expect, it } from "vitest";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore } from "./resource-store.js";
import { TransportError } from "./http-transport.js";
import {
  MAX_READ_WEBPAGE_TEXT_CHARS,
  createReadWebpageDefinition,
} from "./read-webpage-tool.js";

function context() {
  const actor = "main_agent" as const;
  return {
    traceId: "trace-1",
    actor,
    toolSet: new ToolSet([
      {
        identity: { name: "read_webpage", version: 1 },
        actor,
        effect: "network.read.public" as const,
      },
    ]),
  };
}

describe("read_webpage tool", () => {
  it("returns bounded readable text from one safe HTML fetch", async () => {
    const store = new ResourceStore({ idFactory: () => "resource-1" });
    const longText = "宇树科技发布人形机器人进展。".repeat(2000);
    const body = Buffer.from(`<html><head><title>官方进展</title></head><body><main><p>${longText}</p></main></body></html>`);
    const definition = createReadWebpageDefinition({
      store,
      transport: {
        async fetch() {
          return {
            statusCode: 200,
            finalUrl: "https://example.com/news",
            contentType: "text/html",
            body: Buffer.from(body),
            decompressedBytes: body.length,
            sha256: "fixture-sha",
          };
        },
      },
    });

    const output = await definition.execute(
      { url: "https://example.com/news" },
      context(),
      new AbortController().signal,
      () => undefined,
    );

    expect(output.title).toBe("官方进展");
    expect(output.url).toBe("https://example.com/news");
    expect(output.text).toContain("宇树科技发布人形机器人进展");
    expect(output.text.length).toBeLessThanOrEqual(MAX_READ_WEBPAGE_TEXT_CHARS);
    expect(output.truncated).toBe(true);
    expect(store.size()).toBe(0);
  });

  it("preserves a safe timeout classification", async () => {
    const definition = createReadWebpageDefinition({
      store: new ResourceStore(),
      transport: { async fetch() { throw new TransportError("timeout"); } },
    });

    await expect(
      definition.execute(
        { url: "https://example.com/slow" },
        context(),
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

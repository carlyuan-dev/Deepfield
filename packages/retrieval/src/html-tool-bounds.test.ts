import { describe, expect, it } from "vitest";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParseHtmlDefinition } from "./html-tool.js";

const toolSet = new ToolSet([
  { identity: { name: "parse_html", version: 1 }, actor: "main_agent", effect: "project.read" },
]);

function context() {
  return { traceId: "t1", actor: "main_agent" as const, toolSet };
}

function scope(traceId = "t1"): ResourceScope {
  return { traceId, toolSetFingerprint: toolSet.fingerprint() };
}

const metadata = (contentType = "text/html", finalUrl = "https://example.com/original") => ({
  finalUrl,
  contentType,
  size: 0,
  sha256: "abc",
});

describe("parse_html auxiliary field bounds (focused revision)", () => {
  it("caps the title and marks truncated", async () => {
    const store = new ResourceStore({ idFactory: () => "res-title" });
    const { id } = store.put(scope("t1"), Buffer.from(`<html><head><title>${"T".repeat(300_000)}</title></head><body><p>x</p></body></html>`), metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.title.length).toBeLessThanOrEqual(500);
    expect(output.truncated).toBe(true);
  });

  it("caps the locator count and per-locator text/path, marking truncated", async () => {
    const many = `<html><body>${"<p>短</p>".repeat(3000)}</body></html>`;
    const store = new ResourceStore({ idFactory: () => "res-loc" });
    const { id } = store.put(scope("t1"), Buffer.from(many), metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.locators.length).toBeLessThanOrEqual(2000);
    expect(output.truncated).toBe(true);
  });

  it("caps href and link text, marking truncated", async () => {
    // overlong href: SKIPPED (never rewritten); long link text on a short
    // href: kept with a bounded text
    const longHref = `https://x.example/${"p".repeat(10_000)}`;
    const store = new ResourceStore({ idFactory: () => "res-href" });
    const { id } = store.put(scope("t1"), Buffer.from(`<html><body><a href="${longHref}">x</a></body></html>`), metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.links).toHaveLength(0); // skipped, never truncated into a fake URL
    expect(output.truncated).toBe(true);

    const longText = `<html><body><a href="https://x.example/short">${"link text ".repeat(1000)}</a></body></html>`;
    const store2 = new ResourceStore({ idFactory: () => "res-text" });
    const { id: id2 } = store2.put(scope("t1"), Buffer.from(longText), metadata());
    const definition2 = createParseHtmlDefinition({ store: store2 });
    const output2 = await definition2.execute({ resourceId: id2 }, context(), new AbortController().signal, () => {});
    expect(output2.links).toHaveLength(1);
    expect(output2.links[0]!.href).toBe("https://x.example/short");
    expect(output2.links[0]!.text.length).toBeLessThanOrEqual(200);
    expect(output2.truncated).toBe(true);
  });

  it("keeps the success result when the best-effort zero-fill itself throws", async () => {
    const body = {
      length: 27,
      toString: () => "<html><body><p>zero fill ok</p></body></html>",
      subarray: (start: number) => ({ toString: () => "" }),
      fill() {
        throw new Error("zero-fill failed");
      },
    } as unknown as Buffer;
    const fakeStore = {
      consume: () => ({ body, metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const definition = createParseHtmlDefinition({ store: fakeStore });
    const output = await definition.execute({ resourceId: "r1" }, context(), new AbortController().signal, () => {});
    expect(output.text).toContain("zero fill ok");
    expect(output.truncated).toBe(false);
  });
});

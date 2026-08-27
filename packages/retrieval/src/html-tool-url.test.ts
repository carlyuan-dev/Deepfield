import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParseHtmlDefinition, ParseHtmlOutputSchema } from "./html-tool.js";

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

describe("parse_html URL integrity and schema bounds (focused revision)", () => {
  async function runRaw(body: string, options: { finalUrl?: string; maxLinks?: number } = {}) {
    const store = new ResourceStore({ idFactory: () => "res-url" });
    const { id } = store.put(scope("t1"), Buffer.from(body), metadata("text/html", options.finalUrl ?? "https://example.com/original"));
    const definition = createParseHtmlDefinition({ store, ...(options.maxLinks !== undefined ? { maxLinks: options.maxLinks } : {}) });
    return definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
  }

  it("skips overlong ASCII and percent-encoded/emoji URLs instead of rewriting them", async () => {
    const longAscii = `https://x.example/${"p".repeat(3000)}`;
    const longEncoded = `https://x.example/${"a%20".repeat(900)}` + "\u{1F600}".repeat(100);
    const html = `<html><body><a href="${longAscii}">ascii</a><a href="${longEncoded}">encoded</a><a href="https://ok.example/fine">ok</a></body></html>`;
    const output = await runRaw(html);
    expect(output.links.map((link) => link.href)).toEqual(["https://ok.example/fine"]);
    expect(output.links.some((link) => link.href.length !== new URL(link.href).href.length)).toBe(false);
    expect(output.links.every((link) => !link.href.endsWith("…") && !/p{3,}$/.test(link.href))).toBe(true);
    expect(output.truncated).toBe(true);
  });

  it("keeps normal URLs verbatim as URL.href", async () => {
    const output = await runRaw('<html><body><a href="/report">r</a><a href="https://sub.example.com/a?b=1&amp;c=2">q</a></body></html>');
    expect(output.links[0]!.href).toBe("https://example.com/report");
    expect(output.links[1]!.href).toBe("https://sub.example.com/a?b=1&c=2");
  });

  it("falls back to the bounded resource finalUrl when the canonical is overlong", async () => {
    const overlongCanonical = `<html><head><link rel="canonical" href="https://c.example/${"c".repeat(3000)}"></head><body><p>x</p></body></html>`;
    const output = await runRaw(overlongCanonical);
    expect(output.canonicalUrl).toBe("https://example.com/original");
    expect(output.truncated).toBe(true);
  });

  it("fails closed with invalid_input when the resource finalUrl is invalid or over-bounded", async () => {
    const store = new ResourceStore({ idFactory: () => "res-badurl" });
    const { id } = store.put(scope("t1"), Buffer.from("<html><body><p>x</p></body></html>"), metadata("text/html", "not-a-url"));
    const definition = createParseHtmlDefinition({ store });
    await expect(
      definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const store2 = new ResourceStore({ idFactory: () => "res-badurl2" });
    const { id: id2 } = store2.put(scope("t1"), Buffer.from("<html><body><p>x</p></body></html>"), metadata("text/html", `https://x.example/${"q".repeat(3000)}`));
    const definition2 = createParseHtmlDefinition({ store: store2 });
    await expect(
      definition2.execute({ resourceId: id2 }, context(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("deeply nested paths report truncated=true", async () => {
    const deep = `<html><body>${"<div>".repeat(1000)}<p>深</p>${"</div>".repeat(1000)}</body></html>`;
    const store = new ResourceStore({ idFactory: () => "res-deep" });
    const { id } = store.put(scope("t1"), Buffer.from(deep), metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.locators.length).toBeGreaterThan(0);
    expect(output.locators[0]!.path.length).toBeLessThanOrEqual(500);
    expect(output.truncated).toBe(true);
  });

  it("the schema rejects out-of-bounds auxiliary output", () => {
    const base = {
      title: "t",
      canonicalUrl: "https://example.com/",
      text: "x",
      locators: [],
      links: [],
      truncated: false,
      characterCount: 1,
    };
    expect(Value.Check(ParseHtmlOutputSchema, { ...base, text: "x".repeat(200_001) })).toBe(false);
    expect(Value.Check(ParseHtmlOutputSchema, { ...base, canonicalUrl: `https://x.example/${"p".repeat(2049)}` })).toBe(false);
    expect(Value.Check(ParseHtmlOutputSchema, { ...base, characterCount: 200_001 })).toBe(false);
    expect(Value.Check(ParseHtmlOutputSchema, base)).toBe(true);
  });
});

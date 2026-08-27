import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutionError, ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParseHtmlDefinition, type ParseHtmlOutput } from "./html-tool.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "retrieval");
const FP = "fp-html";

const toolSet = new ToolSet([
  { identity: { name: "parse_html", version: 1 }, actor: "main_agent", effect: "project.read" },
]);

function context(traceId = "t1", projectId?: string) {
  return {
    traceId,
    actor: "main_agent" as const,
    ...(projectId !== undefined ? { projectId } : {}),
    toolSet,
  };
}

function scope(traceId: string, projectId?: string): ResourceScope {
  return { traceId, ...(projectId !== undefined ? { projectId } : {}), toolSetFingerprint: toolSet.fingerprint() };
}

function metadata(contentType = "text/html", finalUrl = "https://example.com/original") {
  return { finalUrl, contentType, size: 0, sha256: "abc" };
}

async function runHtml(
  fixture: string,
  options: { traceId?: string; projectId?: string; contentType?: string; finalUrl?: string; maxChars?: number; maxLinks?: number; store?: ResourceStore } = {},
): Promise<{ output: ParseHtmlOutput; store: ResourceStore }> {
  const store = options.store ?? new ResourceStore({ idFactory: () => "res-1" });
  const body = readFileSync(join(FIXTURES, fixture));
  const { id } = store.put(
    scope(options.traceId ?? "t1", options.projectId),
    body,
    metadata(options.contentType, options.finalUrl),
  );
  const definition = createParseHtmlDefinition({
    store,
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    ...(options.maxLinks !== undefined ? { maxLinks: options.maxLinks } : {}),
  });
  const output = await definition.execute(
    { resourceId: id },
    context(options.traceId ?? "t1", options.projectId),
    new AbortController().signal,
    () => {},
  );
  return { output, store };
}

describe("parse_html definition", () => {
  it("extracts Chinese title, body text, headings, list and table in document order", async () => {
    const { output } = await runHtml("article-zh.html");
    expect(output.title).toBe("人形机器人产业进展");
    expect(output.text).toContain("人形机器人产业进展");
    expect(output.text).toContain("量产计划");
    expect(output.text.indexOf("市场动态")).toBeLessThan(output.text.indexOf("头部企业发布量产计划"));
    expect(output.text.indexOf("头部企业发布量产计划")).toBeLessThan(output.text.indexOf("Q1"));
    expect(output.text.indexOf("Q1")).toBeLessThan(output.text.indexOf("Q2"));
    expect(output.text).not.toContain("window.__STATE__");
    expect(output.text).not.toContain("MARKER_SCRIPT_BODY");
    expect(output.truncated).toBe(false);
  });

  it("resolves absolute and relative links, drops unsafe schemes and caps the link count", async () => {
    const { output } = await runHtml("article-zh.html");
    const hrefs = output.links.map((link) => link.href);
    expect(hrefs).toContain("https://example.com/report"); // relative resolved
    expect(hrefs).toContain("https://external.example.com/analysis");
    expect(hrefs.some((href) => href.startsWith("javascript:"))).toBe(false);
    expect(hrefs.some((href) => href.startsWith("data:"))).toBe(false);
    expect(hrefs.some((href) => href.startsWith("file:"))).toBe(false);
    // 500-link cap
    const many = "<html><body>" + Array.from({ length: 520 }, (_, index) => `<a href="https://x.example/${index}">l${index}</a>`).join("") + "</body></html>";
    const store = new ResourceStore({ idFactory: () => "res-cap" });
    const { id } = store.put(scope("t1"), Buffer.from(many), metadata());
    const definition = createParseHtmlDefinition({ store });
    const capped = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(capped.links).toHaveLength(500);
    expect(capped.truncated).toBe(true);
  });

  it("extracts canonical URL with a safe scheme and falls back to the resource finalUrl", async () => {
    const { output } = await runHtml("article-zh.html");
    expect(output.canonicalUrl).toBe("https://example.com/report");
    // unsafe canonical -> fallback
    const unsafe = '<html><head><link rel="canonical" href="javascript:alert(1)"></head><body><p>x</p></body></html>';
    const store = new ResourceStore({ idFactory: () => "res-c" });
    const { id } = store.put(scope("t1"), Buffer.from(unsafe), metadata("text/html", "https://fallback.example/page"));
    const definition = createParseHtmlDefinition({ store });
    const fallback = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(fallback.canonicalUrl).toBe("https://fallback.example/page");
  });

  it("removes script/style/template/noscript and hidden noise", async () => {
    const { output } = await runHtml("noise-hidden.html");
    expect(output.text).not.toContain("MARKER_SCRIPT_9c1b");
    expect(output.text).not.toContain("MARKER_TEMPLATE");
    expect(output.text).not.toContain("noscript content");
    expect(output.text).not.toContain("hidden by style");
    expect(output.text).not.toContain("hidden by visibility");
    expect(output.text).not.toContain("hidden attribute");
    expect(output.text).not.toContain("aria hidden");
    expect(output.text).toContain("Visible paragraph one");
    expect(output.text).toContain("Visible paragraph two");
  });

  it("normalizes whitespace and preserves structural locators", async () => {
    const { output } = await runHtml("table-links.html");
    expect(output.text).not.toContain("\n");
    expect(output.locators.length).toBeGreaterThan(3);
    expect(output.locators.some((locator) => locator.tag === "td")).toBe(true);
    expect(output.locators.some((locator) => locator.tag === "li")).toBe(false); // no list in this fixture
    // table cell order: First link before Relative two before Cell text three before Fourth link
    const positions = output.locators.map((locator) => locator.text);
    expect(positions.indexOf("First link")).toBeLessThan(positions.indexOf("Relative two"));
    expect(positions.indexOf("Relative two")).toBeLessThan(positions.indexOf("Cell text three"));
    expect(positions.indexOf("Cell text three")).toBeLessThan(positions.indexOf("Fourth link"));
  });

  it("caps the normalized text at 200,000 characters during construction and marks truncated", async () => {
    const huge = `<html><body><h1>标题</h1><p>${"甲".repeat(300_000)}</p></body></html>`;
    const store = new ResourceStore({ idFactory: () => "res-huge" });
    const { id } = store.put(scope("t1"), Buffer.from(huge), metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.text.length).toBeLessThanOrEqual(200_000);
    expect(output.text.length).toBeGreaterThan(199_000);
    expect(output.truncated).toBe(true);
    expect(output.characterCount).toBeLessThanOrEqual(200_000);
  });

  it("fails closed on declared-encoding anomalies with a safe UTF-8 fallback", async () => {
    const bytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="x-unknown-encoding"></head><body><p>'),
      Buffer.from([0xff, 0xfe, 0xfd]), // invalid UTF-8 sequences
      Buffer.from("正常文本</p></body></html>"),
    ]);
    const store = new ResourceStore({ idFactory: () => "res-enc" });
    const { id } = store.put(scope("t1"), bytes, metadata());
    const definition = createParseHtmlDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.text).toContain("正常文本");
    expect(output.text.length).toBeGreaterThan(0);
  });

  it("consumes the resource atomically: the id is unreadable after success and on scope mismatch", async () => {
    const store = new ResourceStore({ idFactory: () => "res-life" });
    const body = Buffer.from("<html><body><p>lifecycle body</p></body></html>");
    const { id } = store.put(scope("t1", "p1"), body, metadata());
    // wrong scope consume attempt by another trace must not delete it
    expect(store.consume(id, scope("t9"))).toBeUndefined();
    expect(store.size()).toBe(1);
    const definition = createParseHtmlDefinition({ store });
    await definition.execute({ resourceId: id }, context("t1", "p1"), new AbortController().signal, () => {});
    expect(store.get(id, scope("t1", "p1"))).toBeUndefined(); // consumed
    expect(store.size()).toBe(0);
  });

  it("fails without leaking the body when the resource is missing or the MIME is wrong", async () => {
    const store = new ResourceStore({ idFactory: () => "res-mime" });
    const { id } = store.put(scope("t1"), Buffer.from("<html><body><p>MARKER_LEAK</p></body></html>"), metadata("application/pdf"));
    const definition = createParseHtmlDefinition({ store });
    await expect(
      definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
    const missing = await definition
      .execute({ resourceId: "no-such-id" }, context(), new AbortController().signal, () => {})
      .catch((error) => error);
    expect(missing).toBeInstanceOf(ToolExecutionError);
    expect(String(missing)).not.toContain("MARKER_LEAK");
  });
});

import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParsePdfDefinition, ParsePdfOutputSchema } from "./pdf-tool.js";
import { joinPageTextBounded } from "./pdf-text.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "retrieval");

const toolSet = new ToolSet([
  { identity: { name: "parse_pdf", version: 1 }, actor: "main_agent", effect: "project.read" },
]);

function context() {
  return { traceId: "t1", actor: "main_agent" as const, toolSet };
}

function scope(traceId = "t1"): ResourceScope {
  return { traceId, toolSetFingerprint: toolSet.fingerprint() };
}

const metadata = () => ({
  finalUrl: "https://example.com/report.pdf",
  contentType: "application/pdf",
  size: 0,
  sha256: "abc",
});

/** Offline deterministic PDF builder (ASCII text pages + optional Info dict). */
function buildPdf(pages: Array<string | null>, options: { info?: Record<string, string> } = {}): Buffer {
  const objects: string[] = [""];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  let nextId = 3;
  const fontId = nextId;
  nextId += 1;
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const pageIds: number[] = [];
  for (const content of pages) {
    const pageId = nextId;
    nextId += 1;
    let contentsRef = "";
    if (content !== null) {
      const contentsId = nextId;
      nextId += 1;
      const escape = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      const chunks: string[] = [];
      for (let offset = 0; offset < content.length; offset += 50_000) {
        chunks.push(`(${escape(content.slice(offset, offset + 50_000))}) Tj`);
      }
      const stream = `BT /F1 12 Tf 72 720 Td ${chunks.join(" ")} ET`;
      objects[contentsId] = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
      contentsRef = ` /Contents ${contentsId} 0 R`;
    }
    const width = Math.max(612, (content?.length ?? 0) * 7 + 144);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 ${fontId} 0 R >> >>${contentsRef} >>`;
    pageIds.push(pageId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let infoRef = "";
  if (options.info !== undefined) {
    const infoId = nextId;
    nextId += 1;
    const escape = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const entries = Object.entries(options.info)
      .map(([key, value]) => `/${key} (${escape(value)})`)
      .join(" ");
    objects[infoId] = `<< ${entries} >>`;
    infoRef = ` /Info ${infoId} 0 R`;
  }
  let pdf = "%PDF-1.4\n";
  for (let id = 1; id < nextId; id += 1) {
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${nextId}${infoRef} >>\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

describe("parse_pdf bounded join and caps (focused revision)", () => {
  function makeItem(str: string, y: number, x = 0): { str: string; transform: number[] } {
    return { str, transform: [1, 0, 0, 1, x, y] };
  }

  it("stops constructing the page string once the budget is exhausted (lazy str reads)", () => {
    let reads = 0;
    const items = [
      { get str(): string { reads += 1; return "aaa"; }, transform: [1, 0, 0, 1, 0, 300] },
      { get str(): string { reads += 1; return "bbb"; }, transform: [1, 0, 0, 1, 0, 200] },
      { get str(): string { reads += 1; return "ccc"; }, transform: [1, 0, 0, 1, 0, 100] },
    ];
    // budget 4: "aaa" (3) fits; the second item's length is probed (1) and
    // rejected; the third item must never be read at all.
    const result = joinPageTextBounded(items, 4);
    expect(result.text).toBe("aaa");
    expect(result.truncated).toBe(true);
    expect(reads).toBe(2);
  });

  it("never materializes an oversized item beyond the remaining budget", () => {
    const items = [makeItem("x".repeat(500_000), 300), makeItem("tail", 200)];
    const result = joinPageTextBounded(items, 10);
    expect(result.text.length).toBe(10);
    expect(result.text).toBe("x".repeat(10));
    expect(result.truncated).toBe(true);
  });

  it("keeps stable y/x order and separators inside the budget", () => {
    const items = [makeItem("one", 300), makeItem("two", 200), makeItem("three", 100)];
    const result = joinPageTextBounded(items, 100);
    expect(result.text).toBe("one two three");
    expect(result.truncated).toBe(false);
  });

  it("caps pdf metadata fields and marks truncated", async () => {
    const body = buildPdf(["x"], { info: { Title: "T".repeat(20_000), Producer: "P".repeat(20_000) } });
    const store = new ResourceStore({ idFactory: () => "pdf-meta" });
    const { id } = store.put(scope("t1"), body, metadata());
    const definition = createParsePdfDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.metadata.title.length).toBeLessThanOrEqual(500);
    expect(output.metadata.producer.length).toBeLessThanOrEqual(500);
    expect(output.truncated).toBe(true);
  });

  it("fails closed on invalid maxChars/maxPages configuration", () => {
    const store = new ResourceStore();
    expect(() => createParsePdfDefinition({ store, maxChars: 0 })).toThrow(/maxChars/);
    expect(() => createParsePdfDefinition({ store, maxChars: 400_001 })).toThrow(/maxChars/);
    expect(() => createParsePdfDefinition({ store, maxPages: 0 })).toThrow(/maxPages/);
    expect(() => createParsePdfDefinition({ store, maxPages: 201 })).toThrow(/maxPages/);
    expect(() => createParsePdfDefinition({ store, maxChars: 1.5 })).toThrow(/maxChars/);
  });

  it("the schema rejects out-of-bounds page count and character count", () => {
    const base = {
      title: "t",
      pages: 1,
      metadata: { producer: "", creator: "", title: "" },
      text: [{ page: 1, text: "x" }],
      truncated: false,
      characterCount: 1,
    };
    expect(Value.Check(ParsePdfOutputSchema, { ...base, pages: 201 })).toBe(false);
    expect(Value.Check(ParsePdfOutputSchema, { ...base, characterCount: 400_001 })).toBe(false);
    expect(Value.Check(ParsePdfOutputSchema, { ...base, text: Array.from({ length: 201 }, () => ({ page: 1, text: "" })) })).toBe(false);
    expect(Value.Check(ParsePdfOutputSchema, base)).toBe(true);
  });
});

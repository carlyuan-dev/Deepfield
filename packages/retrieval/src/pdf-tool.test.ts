import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutionError, ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParsePdfDefinition, ParsePdfOutputSchema, type ParsePdfOutput } from "./pdf-tool.js";
import { joinPageTextBounded } from "./pdf-text.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "retrieval");
const FP = "fp-pdf";

const toolSet = new ToolSet([
  { identity: { name: "parse_pdf", version: 1 }, actor: "main_agent", effect: "project.read" },
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

const metadata = (overrides: Partial<{ contentType: string; finalUrl: string }> = {}) => ({
  finalUrl: "https://example.com/report.pdf",
  contentType: "application/pdf",
  size: 0,
  sha256: "abc",
  ...overrides,
});

/** Offline deterministic PDF builder for cap/limit tests (ASCII text pages). */
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
      // PDF string literals are limited to 65535 bytes: chunk long text into
      // multiple Tj operations on the same line.
      const escape = (value: string): string =>
        value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      const chunks: string[] = [];
      for (let offset = 0; offset < content.length; offset += 50_000) {
        chunks.push(`(${escape(content.slice(offset, offset + 50_000))}) Tj`);
      }
      const stream = `BT /F1 12 Tf 72 720 Td ${chunks.join(" ")} ET`;
      objects[contentsId] = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
      contentsRef = ` /Contents ${contentsId} 0 R`;
    }
    // pdfjs clips text at the page boundary: widen the MediaBox per page so
    // long single-line text is fully extracted.
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

function encryptedPdfBytes(): Buffer {
  const head = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [] /Count 0 >>
endobj
3 0 obj
<< /Filter /Standard /V 2 /R 3 /Length 128 /O (00000000000000000000000000000000) /U (00000000000000000000000000000000) /P -44 >>
endobj
trailer
<< /Root 1 0 R /Encrypt 3 0 R /Size 4 >>
%%EOF
`;
  return Buffer.from(head, "utf8");
}

async function runPdf(
  body: Buffer,
  options: { contentType?: string; traceId?: string; projectId?: string; store?: ResourceStore } = {},
): Promise<{ output: ParsePdfOutput; store: ResourceStore }> {
  const store = options.store ?? new ResourceStore({ idFactory: () => "pdf-1" });
  const { id } = store.put(
    scope(options.traceId ?? "t1", options.projectId),
    body,
    metadata({ contentType: options.contentType ?? "application/pdf" }),
  );
  const definition = createParsePdfDefinition({ store });
  const output = await definition.execute(
    { resourceId: id },
    context(options.traceId ?? "t1", options.projectId),
    new AbortController().signal,
    () => {},
  );
  return { output, store };
}

describe("parse_pdf definition", () => {
  it("extracts two pages of Chinese and English text with stable page numbers from 1", async () => {
    const body = readFileSync(join(FIXTURES, "report-two-pages.pdf"));
    const { output } = await runPdf(body);
    expect(output.pages).toBe(2);
    expect(output.text.map((page) => page.page)).toEqual([1, 2]);
    expect(output.text[0]!.text).toContain("Report: Page One");
    expect(output.text[0]!.text).toContain("人形");
    expect(output.text[1]!.text).toContain("Second Page");
    expect(output.truncated).toBe(false);
  });

  it("returns safe metadata from the Info dictionary", async () => {
    const body = readFileSync(join(FIXTURES, "report-two-pages.pdf"));
    const { output } = await runPdf(body);
    expect(output.metadata.producer).toBe("DeepfieldFixtureWriter");
    expect(output.metadata.creator).toBe("handcrafted");
    expect(output.metadata.title).toBe("Two Page Report");
    expect(output.title).toBe("Two Page Report");
  });

  it("retains empty pages with their page numbers", async () => {
    const body = readFileSync(join(FIXTURES, "report-empty-page.pdf"));
    const { output } = await runPdf(body);
    expect(output.text).toHaveLength(2);
    expect(output.text[0]).toMatchObject({ page: 1, text: "First Page" });
    expect(output.text[1]).toMatchObject({ page: 2, text: "" });
  });

  it("fails safely on damaged input without leaking bytes or causes", async () => {
    const body = readFileSync(join(FIXTURES, "report-damaged.pdf"));
    const store = new ResourceStore({ idFactory: () => "pdf-dmg" });
    const { id } = store.put(scope("t1"), body, metadata());
    const definition = createParsePdfDefinition({ store });
    const error = await definition
      .execute({ resourceId: id }, context(), new AbortController().signal, () => {})
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(String(error)).not.toContain("%PDF");
    expect(String(error)).not.toContain("InvalidPDFException");
    expect(store.size()).toBe(0); // the resource was consumed even on failure
  });

  it("fails safely on encrypted/password-protected input", async () => {
    const store = new ResourceStore({ idFactory: () => "pdf-enc" });
    const { id } = store.put(scope("t1"), encryptedPdfBytes(), metadata());
    const definition = createParsePdfDefinition({ store });
    await expect(
      definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(store.size()).toBe(0);
  });

  it("caps total characters at 400,000 during construction and marks truncated", async () => {
    const body = buildPdf([null, "x".repeat(500_000)]);
    const store = new ResourceStore({ idFactory: () => "pdf-cap" });
    const { id } = store.put(scope("t1"), body, metadata());
    const definition = createParsePdfDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    const total = output.text.reduce((sum, page) => sum + page.text.length, 0);
    expect(total).toBeLessThanOrEqual(400_000);
    expect(output.truncated).toBe(true);
    expect(output.characterCount).toBeLessThanOrEqual(400_000);
  });

  it("caps pages at 200 and marks truncated", async () => {
    const body = buildPdf(Array.from({ length: 205 }, () => null));
    const store = new ResourceStore({ idFactory: () => "pdf-pages" });
    const { id } = store.put(scope("t1"), body, metadata());
    const definition = createParsePdfDefinition({ store });
    const output = await definition.execute({ resourceId: id }, context(), new AbortController().signal, () => {});
    expect(output.text).toHaveLength(200);
    expect(output.text[0]!.page).toBe(1);
    expect(output.text[199]!.page).toBe(200);
    expect(output.truncated).toBe(true);
  });

  it("consumes the resource on success and never deletes another scope's resource", async () => {
    const store = new ResourceStore({ idFactory: () => "pdf-life" });
    const body = buildPdf(["lifecycle text"]);
    const { id } = store.put(scope("t1", "p1"), body, metadata());
    expect(store.consume(id, scope("t9"))).toBeUndefined();
    expect(store.size()).toBe(1);
    const definition = createParsePdfDefinition({ store });
    await definition.execute({ resourceId: id }, context("t1", "p1"), new AbortController().signal, () => {});
    expect(store.get(id, scope("t1", "p1"))).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("rejects a non-PDF resource with a safe code and no body leak", async () => {
    const store = new ResourceStore({ idFactory: () => "pdf-mime" });
    const body = Buffer.from("<html><body>MARKER_PDF_LEAK_xyz</body></html>");
    const { id } = store.put(scope("t1"), body, metadata({ contentType: "text/html" }));
    const definition = createParsePdfDefinition({ store });
    const error = await definition
      .execute({ resourceId: id }, context(), new AbortController().signal, () => {})
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "unsupported_content_type" });
    expect(String(error)).not.toContain("MARKER_PDF_LEAK_xyz");
  });
});

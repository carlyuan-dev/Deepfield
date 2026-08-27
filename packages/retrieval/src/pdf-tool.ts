import { Type, type Static } from "typebox";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";
import { ResourceStore, zeroFillBuffer } from "./resource-store.js";
import { scopeFromContext } from "./fetch-tools.js";

export const ParsePdfInputSchema = Type.Object(
  { resourceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ParsePdfInput = Static<typeof ParsePdfInputSchema>;

export const PdfPageTextSchema = Type.Object(
  {
    page: Type.Integer({ minimum: 1 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);
export type PdfPageText = Static<typeof PdfPageTextSchema>;

export const ParsePdfOutputSchema = Type.Object(
  {
    title: Type.String(),
    pages: Type.Integer({ minimum: 0 }),
    metadata: Type.Object(
      {
        producer: Type.String(),
        creator: Type.String(),
        title: Type.String(),
      },
      { additionalProperties: false },
    ),
    text: Type.Array(PdfPageTextSchema),
    truncated: Type.Boolean(),
    characterCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ParsePdfOutput = Static<typeof ParsePdfOutputSchema>;

export interface ParsePdfDeps {
  store: ResourceStore;
  maxChars?: number;
  maxPages?: number;
}

const DEFAULT_MAX_CHARS = 400_000;
const DEFAULT_MAX_PAGES = 200;
// Self-contained data URI so the standard-font data factory never touches the
// network; text extraction does not need real font glyphs.
const STANDARD_FONT_DATA_URL = "data:application/octet-stream;base64,";

interface TextItem {
  str: string;
  transform: number[];
}

/**
 * Stable reading order: larger y first (PDF y grows upward), then smaller x;
 * joined with a single space per item boundary.
 */
export function joinPageText(items: readonly TextItem[]): string {
  const sorted = [...items].sort((a, b) => {
    const yOrder = b.transform[5]! - a.transform[5]!;
    if (yOrder !== 0) {
      return yOrder;
    }
    return a.transform[4]! - b.transform[4]!;
  });
  return sorted.map((item) => item.str).join(" ");
}

export function createParsePdfDefinition(
  deps: ParsePdfDeps,
): ToolDefinition<typeof ParsePdfInputSchema, typeof ParsePdfOutputSchema> {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  return {
    identity: { name: "parse_pdf", version: 1 },
    label: "Parse PDF",
    description: "Parse a stored PDF resource into ordered per-page text and safe metadata.",
    inputSchema: ParsePdfInputSchema,
    outputSchema: ParsePdfOutputSchema,
    effect: "project.read",
    timeoutMs: 30_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "parse", countsBytes: false, countsTime: true },
    async execute(input, context, signal) {
      const scope = scopeFromContext(context);
      const view = deps.store.consume(input.resourceId, scope);
      if (view === undefined) {
        throw new ToolExecutionError("invalid_input");
      }
      const buffer = view.body; // the defensive copy handed back by consume
      let pdf: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined = undefined;
      try {
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        if (view.metadata.contentType !== "application/pdf") {
          throw new ToolExecutionError("unsupported_content_type");
        }
        pdf = await getDocument({
          data: new Uint8Array(buffer),
          isEvalSupported: false,
          useSystemFonts: false,
          disableFontFace: true,
          disableAutoFetch: true,
          disableStream: true,
          standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        const info = (await pdf.getMetadata().then((meta) => meta.info, () => ({}))) as Record<string, unknown>;
        const title = typeof info.Title === "string" ? info.Title : "";
        const producer = typeof info.Producer === "string" ? info.Producer : "";
        const creator = typeof info.Creator === "string" ? info.Creator : "";
        const pages: PdfPageText[] = [];
        let total = 0;
        let truncated = false;
        const pageLimit = Math.min(pdf.numPages, maxPages);
        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
          if (signal.aborted) {
            throw new ToolExecutionError("cancelled");
          }
          const page = await pdf.getPage(pageNumber);
          try {
            const content = await page.getTextContent();
            const pageText = joinPageText(content.items as never as readonly TextItem[]);
            if (total + pageText.length > maxChars) {
              const remaining = maxChars - total;
              if (remaining > 0) {
                pages.push({ page: pageNumber, text: pageText.slice(0, remaining) });
              }
              total = maxChars;
              truncated = true;
              break;
            }
            pages.push({ page: pageNumber, text: pageText });
            total += pageText.length;
          } finally {
            page.cleanup();
          }
        }
        if (pdf.numPages > maxPages) {
          truncated = true;
        }
        return {
          title,
          pages: pages.length,
          metadata: { producer, creator, title },
          text: pages,
          truncated,
          characterCount: total,
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        // PasswordException / InvalidPDFException / malformed: stable safe code,
        // never the PDF bytes or the parser's raw cause.
        throw new ToolExecutionError("invalid_input");
      } finally {
        if (pdf !== undefined) {
          await pdf.destroy().catch(() => {});
        }
        zeroFillBuffer(buffer);
      }
    },
  };
}

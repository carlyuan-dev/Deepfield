import { Type, type Static } from "typebox";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";
import { ResourceStore, safeZeroFill } from "./resource-store.js";
import { scopeFromContext } from "./fetch-tools.js";

export const ParsePdfInputSchema = Type.Object(
  { resourceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ParsePdfInput = Static<typeof ParsePdfInputSchema>;

export const PdfPageTextSchema = Type.Object(
  {
    page: Type.Integer({ minimum: 1 }),
    text: Type.String({ maxLength: 400_000 }),
  },
  { additionalProperties: false },
);
export type PdfPageText = Static<typeof PdfPageTextSchema>;

export const ParsePdfOutputSchema = Type.Object(
  {
    title: Type.String({ maxLength: 500 }),
    pages: Type.Integer({ minimum: 0 }),
    metadata: Type.Object(
      {
        producer: Type.String({ maxLength: 500 }),
        creator: Type.String({ maxLength: 500 }),
        title: Type.String({ maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
    text: Type.Array(PdfPageTextSchema, { maxItems: 200 }),
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
  /** Narrow injectable PDF loader (defaults to pdfjs); never exposed outside retrieval. */
  loader?: PdfLoader;
}

const DEFAULT_MAX_CHARS = 400_000;
const HARD_MAX_CHARS = 400_000;
const DEFAULT_MAX_PAGES = 200;
const HARD_MAX_PAGES = 200;
const MAX_METADATA_LENGTH = 500;
// Self-contained data URI so the standard-font data factory never touches the
// network; text extraction does not need real font glyphs.
const STANDARD_FONT_DATA_URL = "data:application/octet-stream;base64,";

export interface TextItem {
  str: string;
  transform: number[];
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly TextItem[] }>;
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getMetadata(): Promise<{ info: Record<string, unknown> }>;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

/** Narrow loader contract: a pdfjs-like loading task with a destroyable promise. */
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): void;
}

export type PdfLoader = (data: Uint8Array) => PdfLoadingTaskLike;

function defaultLoader(data: Uint8Array): PdfLoadingTaskLike {
  // pdfjs's loading task matches the narrow contract; the rich document
  // proxy is structurally compatible with PdfDocumentLike for our usage.
  return getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }) as unknown as PdfLoadingTaskLike;
}

function boundedMeta(value: string, truncated: { value: boolean }): string {
  if (value.length > MAX_METADATA_LENGTH) {
    truncated.value = true;
    return value.slice(0, MAX_METADATA_LENGTH);
  }
  return value;
}

/**
 * Stable reading order (larger y first, then smaller x) with a hard character
 * budget applied DURING construction: items are appended one at a time with
 * the separator counted, and string building stops the moment the budget is
 * exhausted — an oversized page never materializes as a full string first.
 */
export function joinPageTextBounded(
  items: readonly TextItem[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const sorted = [...items].sort((a, b) => {
    const yOrder = b.transform[5]! - a.transform[5]!;
    if (yOrder !== 0) {
      return yOrder;
    }
    return a.transform[4]! - b.transform[4]!;
  });
  const parts: string[] = [];
  let used = 0;
  for (const item of sorted) {
    const str = item.str; // read each item's string exactly once
    const separator = parts.length > 0 ? 1 : 0;
    const cost = separator + str.length;
    if (used + cost > maxChars) {
      const remaining = maxChars - used - separator;
      if (remaining > 0) {
        parts.push(str.slice(0, remaining));
        used = maxChars;
      }
      return { text: parts.join(" "), truncated: true };
    }
    parts.push(str);
    used += cost;
  }
  return { text: parts.join(" "), truncated: false };
}

/** Unbounded convenience join (used by tests/exporters; the tool itself is bounded). */
export function joinPageText(items: readonly TextItem[]): string {
  return joinPageTextBounded(items, Number.MAX_SAFE_INTEGER).text;
}

function assertConfig(value: number | undefined, name: "maxChars" | "maxPages", hardMax: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > hardMax) {
    throw new TypeError(`invalid ${name}: must be a positive integer up to ${hardMax}`);
  }
}

export function createParsePdfDefinition(
  deps: ParsePdfDeps,
): ToolDefinition<typeof ParsePdfInputSchema, typeof ParsePdfOutputSchema> {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const loader = deps.loader ?? defaultLoader;
  assertConfig(maxChars, "maxChars", HARD_MAX_CHARS);
  assertConfig(maxPages, "maxPages", HARD_MAX_PAGES);
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
      if (signal.aborted) {
        safeZeroFill(buffer);
        throw new ToolExecutionError("cancelled");
      }
      if (view.metadata.contentType !== "application/pdf") {
        safeZeroFill(buffer);
        throw new ToolExecutionError("unsupported_content_type");
      }
      const task = loader(new Uint8Array(buffer));
      let destroyed = false;
      const destroyTask = (): void => {
        if (!destroyed) {
          destroyed = true;
          task.destroy();
        }
      };
      const onAbort = (): void => destroyTask();
      signal.addEventListener("abort", onAbort, { once: true });
      let pdf: PdfDocumentLike | undefined;
      try {
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        pdf = await task.promise;
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        const info = (await pdf.getMetadata().then((meta) => meta.info, () => ({}))) as Record<string, unknown>;
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        const truncated = { value: false };
        const metaTitle = boundedMeta(typeof info.Title === "string" ? info.Title : "", truncated);
        const metaProducer = boundedMeta(typeof info.Producer === "string" ? info.Producer : "", truncated);
        const metaCreator = boundedMeta(typeof info.Creator === "string" ? info.Creator : "", truncated);
        const pages: PdfPageText[] = [];
        let total = 0;
        let textTruncated = false;
        const pageLimit = Math.min(pdf.numPages, maxPages);
        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
          if (signal.aborted) {
            throw new ToolExecutionError("cancelled");
          }
          const page = await pdf.getPage(pageNumber);
          try {
            if (signal.aborted) {
              throw new ToolExecutionError("cancelled");
            }
            const content = await page.getTextContent();
            if (signal.aborted) {
              throw new ToolExecutionError("cancelled");
            }
            const bounded = joinPageTextBounded(content.items as readonly TextItem[], maxChars - total);
            pages.push({ page: pageNumber, text: bounded.text });
            total += bounded.text.length;
            if (bounded.truncated) {
              total = maxChars;
              textTruncated = true;
              break;
            }
          } finally {
            page.cleanup();
          }
        }
        if (pdf.numPages > maxPages) {
          textTruncated = true;
        }
        return {
          title: metaTitle,
          pages: pages.length,
          metadata: { producer: metaProducer, creator: metaCreator, title: metaTitle },
          text: pages,
          truncated: textTruncated || truncated.value,
          characterCount: total,
        };
      } catch (error) {
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled"); // cancel wins over any parser error
        }
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        // PasswordException / InvalidPDFException / malformed: stable safe code,
        // never the PDF bytes or the parser's raw cause.
        throw new ToolExecutionError("invalid_input");
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (pdf !== undefined) {
          await pdf.destroy().catch(() => {});
        }
        destroyTask(); // idempotent: no-op when the abort listener already destroyed
        safeZeroFill(buffer); // best-effort: a failing zero-fill never changes the result
      }
    },
  };
}

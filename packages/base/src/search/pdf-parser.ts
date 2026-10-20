import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SearchResourceError } from "./errors.js";
import { ResourceStore, safeZeroFill, type ResourceScope } from "./resource-store.js";
import { MAX_PDF_CHARS, MAX_PDF_PAGES, MAX_PDF_METADATA_LENGTH, joinPageTextBounded, type TextItem } from "./pdf-text.js";
import { createAbortGuard, createMemoizedDestroy, type PdfLoader, type PdfLoadingTaskLike } from "./pdf-lifecycle.js";


import type { ParsePdfOutput, PdfPageText } from "./parsing-contracts.js";
export interface ParsePdfDeps {
  store: ResourceStore;
  maxChars?: number;
  maxPages?: number;
  /** Narrow injectable PDF loader; defaults to pdfjs in this runtime. */
  loader?: PdfLoader;
}

const DEFAULT_MAX_CHARS = MAX_PDF_CHARS;
const HARD_MAX_CHARS = MAX_PDF_CHARS;
const DEFAULT_MAX_PAGES = MAX_PDF_PAGES;
const HARD_MAX_PAGES = MAX_PDF_PAGES;
const MAX_METADATA_LENGTH = MAX_PDF_METADATA_LENGTH;
// Self-contained data URI so the standard-font data factory never touches the
// network; text extraction does not need real font glyphs.
const STANDARD_FONT_DATA_URL = "data:application/octet-stream;base64,";

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

function assertConfig(value: number | undefined, name: "maxChars" | "maxPages", hardMax: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > hardMax) {
    throw new TypeError(`invalid ${name}: must be a positive integer up to ${hardMax}`);
  }
}

export function createPdfParser(deps: ParsePdfDeps) {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const loader = deps.loader ?? defaultLoader;
  assertConfig(maxChars, "maxChars", HARD_MAX_CHARS);
  assertConfig(maxPages, "maxPages", HARD_MAX_PAGES);
  return async (resourceId: string, scope: ResourceScope, signal: AbortSignal): Promise<ParsePdfOutput> => {
    const view = deps.store.consume(resourceId, scope);
    if (view === undefined) {
      throw new SearchResourceError("invalid_input");
    }
    const buffer = view.body; // the defensive copy handed back by consume
    if (signal.aborted) {
      safeZeroFill(buffer);
      throw new SearchResourceError("cancelled");
    }
    if (view.metadata.contentType !== "application/pdf") {
      safeZeroFill(buffer);
      throw new SearchResourceError("unsupported_content_type");
    }
    // The data copy and the loader creation live INSIDE the safety boundary:
    // a synchronous loader throw maps to a stable code and both copies are
    // zero-filled on every path.
    let dataView: Uint8Array | undefined;
    let task: PdfLoadingTaskLike | undefined;
    const startDestroy = createMemoizedDestroy(() => task);
    const guard = createAbortGuard(signal);
    const removeAbort = guard.addAbortListener(() => {
      void startDestroy(); // rejection observed inside the memoized cleanup
    });
    try {
      if (signal.aborted) {
        throw new SearchResourceError("cancelled");
      }
      dataView = new Uint8Array(buffer);
      try {
        task = loader(dataView);
      } catch {
        if (signal.aborted) {
          throw new SearchResourceError("cancelled");
        }
        throw new SearchResourceError("invalid_input");
      }
      if (signal.aborted) {
        throw new SearchResourceError("cancelled");
      }
      const pdf = await guard.race(task.promise);
      if (signal.aborted) {
        throw new SearchResourceError("cancelled");
      }
      const info = (await guard.race(pdf.getMetadata()).then((meta) => meta.info, () => ({}))) as Record<string, unknown>;
      if (signal.aborted) {
        throw new SearchResourceError("cancelled");
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
          throw new SearchResourceError("cancelled");
        }
        const page = await guard.race(pdf.getPage(pageNumber));
        try {
          if (signal.aborted) {
            throw new SearchResourceError("cancelled");
          }
          const content = await guard.race(page.getTextContent());
          if (signal.aborted) {
            throw new SearchResourceError("cancelled");
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
        throw new SearchResourceError("cancelled"); // cancel wins over any parser error
      }
      if (error instanceof SearchResourceError) {
        throw error;
      }
      // PasswordException / InvalidPDFException / malformed: stable safe code,
      // never the PDF bytes or the parser's raw cause.
      throw new SearchResourceError("invalid_input");
    } finally {
      try {
        if (signal.aborted) {
          // cancel must settle promptly even if a hostile destroy never settles
          void startDestroy();
        } else {
          // The abort listener stays attached THROUGH the cleanup, and the
          // cleanup wait races the abort signal: a never-settling destroy can
          // neither hang the execution nor let a late completion turn into
          // success after the caller aborted.
          await Promise.race([startDestroy(), guard.abortSignal]);
        }
      } finally {
        safeZeroFill(buffer);
        if (dataView !== undefined) {
          safeZeroFill(dataView as unknown as Buffer);
        }
        removeAbort();
      }
    }
  };
}

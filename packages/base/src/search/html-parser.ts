import { SearchResourceError } from "./errors.js";
import { ResourceStore, safeZeroFill, type ResourceScope } from "./resource-store.js";
import {
  decodeHtml,
  extractHtml,
  validateResourceBaseUrl,
} from "./html-extraction.js";

import type { ParseHtmlOutput } from "./parsing-contracts.js";
export interface ParseHtmlDeps {
  store: ResourceStore;
  maxChars?: number;
  maxLinks?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const HARD_MAX_CHARS = 200_000;
const DEFAULT_MAX_LINKS = 500;
const HARD_MAX_LINKS = 500;

function assertConfig(value: number | undefined, name: "maxChars" | "maxLinks", hardMax: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > hardMax) {
    throw new TypeError(`invalid ${name}: must be a positive integer up to ${hardMax}`);
  }
}

export function createHtmlParser(deps: ParseHtmlDeps) {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLinks = deps.maxLinks ?? DEFAULT_MAX_LINKS;
  assertConfig(maxChars, "maxChars", HARD_MAX_CHARS);
  assertConfig(maxLinks, "maxLinks", HARD_MAX_LINKS);
  return async (resourceId: string, scope: ResourceScope, signal: AbortSignal): Promise<ParseHtmlOutput> => {
    const view = deps.store.consume(resourceId, scope);
    if (view === undefined) {
      throw new SearchResourceError("invalid_input");
    }
    const buffer = view.body; // the defensive copy handed back by consume
    try {
      if (signal.aborted) {
        throw new SearchResourceError("cancelled");
      }
      if (view.metadata.contentType !== "text/html" && view.metadata.contentType !== "application/xhtml+xml") {
        throw new SearchResourceError("unsupported_content_type");
      }
      const html = decodeHtml(buffer);
      const baseUrl = validateResourceBaseUrl(view.metadata.finalUrl);
      const result = extractHtml(html, baseUrl, maxChars, maxLinks);
      return {
        title: result.title,
        canonicalUrl: result.canonicalUrl,
        text: result.text,
        locators: result.locators,
        links: result.links,
        truncated: result.truncated,
        characterCount: result.characterCount,
      };
    } catch (error) {
      if (error instanceof SearchResourceError) {
        throw error;
      }
      // never leak parser exceptions or raw content
      throw new SearchResourceError("invalid_input");
    } finally {
      safeZeroFill(buffer); // best-effort: a failing zero-fill never changes the result
    }
  };
}

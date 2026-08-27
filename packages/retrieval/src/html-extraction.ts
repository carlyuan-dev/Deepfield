import * as cheerio from "cheerio";
import type { HtmlLink, HtmlLocator } from "./html-tool.js";

export const MAX_TITLE = 500;
export const MAX_LOCATORS = 2000;
export const MAX_LOCATOR_TEXT = 200;
export const MAX_LOCATOR_PATH = 500;
export const MAX_HREF = 2048;
export const MAX_LINK_TEXT = 200;
export const MAX_CANONICAL = 2048;

const CONTENT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "td", "th", "dt", "dd", "caption", "blockquote", "pre", "figcaption", "summary",
]);
const HIDDEN_STYLE_RE = /\b(display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Deterministic UTF-8 decode: BOM-aware, invalid sequences become U+FFFD. */
export function decodeHtml(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

/**
 * Resolves to an absolute http/https URL, VERBATIM (URL.href), or undefined for
 * unsafe/malformed hrefs. Callers must never slice the result into a different
 * URL: overlong links are skipped, not rewritten.
 */
export function safeResolveUrl(href: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch {
    // malformed href: skip
  }
  return undefined;
}

/**
 * Validates the resource finalUrl used as the resolution base: must be an
 * absolute http/https URL within the canonical bound. Anything else is a
 * stable invalid_input rather than a fabricated base.
 */
export function validateResourceBaseUrl(finalUrl: string): string {
  if (typeof finalUrl !== "string" || finalUrl.length === 0 || finalUrl.length > MAX_CANONICAL) {
    throw new Error("invalid finalUrl");
  }
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    throw new Error("invalid finalUrl");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid finalUrl");
  }
  return url.href;
}

export interface ExtractionResult {
  title: string;
  canonicalUrl: string;
  text: string;
  locators: HtmlLocator[];
  links: HtmlLink[];
  truncated: boolean;
  characterCount: number;
}

/**
 * Deterministic HTML extraction. Cheerio is used purely as a parser: no
 * scripts execute and no subresources load. Unsafe/noise nodes are removed
 * before walking headings, paragraphs, list items, table cells and anchors in
 * document order. EVERY cap applies during construction — the text budget, the
 * link cap and every auxiliary field bound — so a huge page never builds an
 * unbounded intermediate string or array. URLs are never truncated into a
 * different address: overlong links are skipped and reported as truncated.
 */
export function extractHtml(
  html: string,
  baseUrl: string,
  maxChars: number,
  maxLinks: number,
): ExtractionResult {
  const dom = cheerio.load(html);
  const rawTitle = normalizeWhitespace(dom("title").first().text());
  let title = rawTitle;
  let titleTruncated = false;
  if (title.length > MAX_TITLE) {
    title = title.slice(0, MAX_TITLE);
    titleTruncated = true;
  }
  const canonical = dom('link[rel="canonical"]').first().attr("href");
  const resolvedCanonical = canonical !== undefined ? safeResolveUrl(canonical, baseUrl) : undefined;
  let canonicalUrl = baseUrl;
  let canonicalTruncated = false;
  if (resolvedCanonical !== undefined && resolvedCanonical.length <= MAX_CANONICAL) {
    canonicalUrl = resolvedCanonical;
  } else if (resolvedCanonical !== undefined) {
    // overlong canonical: ignore it rather than emit a rewritten address
    canonicalTruncated = true;
  }
  // Remove unsafe and hidden noise before any text walk.
  dom("script, style, template, noscript, head").remove();
  dom("[hidden], [aria-hidden='true']").remove();
  dom("[style]").each((_index, element) => {
    if (HIDDEN_STYLE_RE.test(dom(element).attr("style") ?? "")) {
      dom(element).remove();
    }
  });

  const segments: string[] = [];
  const locators: HtmlLocator[] = [];
  const links: HtmlLink[] = [];
  let characterCount = 0;
  let textTruncated = false;
  let linksCapped = false;
  let locatorsCapped = false;
  let pathTruncated = false;
  let auxTruncated = false;

  const appendText = (text: string): void => {
    if (textTruncated || text.length === 0) {
      return;
    }
    const leading = segments.length > 0 ? " " : "";
    const cost = leading.length + text.length;
    if (characterCount + cost > maxChars) {
      const remaining = maxChars - characterCount - leading.length;
      if (remaining > 0) {
        segments.push(leading + text.slice(0, remaining));
        characterCount = maxChars;
      }
      textTruncated = true;
      return;
    }
    segments.push(leading + text);
    characterCount += cost;
  };

  const appendLocator = (locator: HtmlLocator): void => {
    if (locators.length >= MAX_LOCATORS) {
      locatorsCapped = true;
      return;
    }
    locators.push(locator);
  };

  /** Bounded incremental path: stops growing at the cap and reports the cutoff. */
  const appendPathSegment = (
    parentPath: string,
    tag: string,
    index: number,
  ): { path: string; grew: boolean } => {
    const segment = `${tag}[${index}]`;
    if (parentPath.length === 0) {
      return {
        path: segment.length > MAX_LOCATOR_PATH ? segment.slice(0, MAX_LOCATOR_PATH) : segment,
        grew: true,
      };
    }
    const candidate = `${parentPath}>${segment}`;
    if (candidate.length > MAX_LOCATOR_PATH) {
      return { path: parentPath, grew: false };
    }
    return { path: candidate, grew: true };
  };

  interface WalkNode {
    type?: string;
    name?: string;
    parent?: unknown;
  }

  const walk = (element: WalkNode, path: string): void => {
    if (textTruncated && locatorsCapped) {
      return;
    }
    if (element.type === "tag") {
      const tag = (element.name ?? "").toLowerCase();
      const siblings = dom(element.parent as never).children(tag);
      const index = siblings.toArray().indexOf(element as never) + 1;
      const { path: nextPath, grew } = appendPathSegment(path, tag, index);
      if (!grew && path.length > 0) {
        pathTruncated = true;
      }
      if (CONTENT_TAGS.has(tag)) {
        const text = normalizeWhitespace(dom(element as never).text());
        if (text.length > 0) {
          appendText(text);
          appendLocator({
            tag,
            text: text.slice(0, MAX_LOCATOR_TEXT),
            path: nextPath,
          });
        }
        return; // content element is collected as a whole; no double descent
      }
      for (const child of dom(element as never).children().toArray()) {
        walk(child as WalkNode, nextPath);
      }
    }
  };
  for (const child of dom("body").children().toArray()) {
    walk(child as WalkNode, "");
  }

  // Links: capped during traversal. linksCapped is set ONLY when a safe,
  // outputtable link is actually dropped (the maxLinks+1-th one). Overlong
  // URLs are SKIPPED (never sliced into a different address) and reported.
  const anchorElements = dom("a[href]").toArray();
  for (const anchor of anchorElements) {
    const href = dom(anchor).attr("href");
    if (href === undefined) {
      continue;
    }
    const resolved = safeResolveUrl(href, baseUrl);
    if (resolved === undefined) {
      continue; // javascript:/data:/file:/malformed are never exposed
    }
    if (resolved.length > MAX_HREF) {
      auxTruncated = true; // skip, never rewrite the address
      continue;
    }
    if (links.length >= maxLinks) {
      linksCapped = true; // an outputtable safe link is being dropped
      continue;
    }
    const rawLinkText = normalizeWhitespace(dom(anchor).text());
    const linkText = rawLinkText.slice(0, MAX_LINK_TEXT);
    if (rawLinkText.length > MAX_LINK_TEXT) {
      auxTruncated = true;
    }
    links.push({ href: resolved, text: linkText });
  }

  return {
    title,
    canonicalUrl,
    text: segments.join(""),
    locators,
    links,
    truncated:
      textTruncated ||
      linksCapped ||
      titleTruncated ||
      locatorsCapped ||
      pathTruncated ||
      canonicalTruncated ||
      auxTruncated,
    characterCount,
  };
}

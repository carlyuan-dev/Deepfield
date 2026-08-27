import * as cheerio from "cheerio";
import type { HtmlLink, HtmlLocator } from "./html-tool.js";

export const MAX_TITLE = 500;
export const MAX_LOCATORS = 2000;
export const MAX_LOCATOR_TEXT = 200;
export const MAX_LOCATOR_PATH = 500;
export const MAX_HREF = 2048;
export const MAX_LINK_TEXT = 200;

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

/** Resolves to an absolute http/https URL; unsafe or malformed hrefs yield undefined. */
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
 * unbounded intermediate string or array.
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
  const canonicalUrl = resolvedCanonical ?? baseUrl;
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

  interface WalkNode {
    type?: string;
    name?: string;
    parent?: unknown;
  }

  const walk = (element: WalkNode, path: string[]): void => {
    if (textTruncated && locatorsCapped) {
      return;
    }
    if (element.type === "tag") {
      const tag = (element.name ?? "").toLowerCase();
      const siblings = dom(element.parent as never).children(tag);
      const index = siblings.toArray().indexOf(element as never) + 1;
      const nextPath = [...path, `${tag}[${index}]`];
      if (CONTENT_TAGS.has(tag)) {
        const text = normalizeWhitespace(dom(element as never).text());
        if (text.length > 0) {
          appendText(text);
          appendLocator({
            tag,
            text: text.slice(0, MAX_LOCATOR_TEXT),
            path: nextPath.join(">").slice(0, MAX_LOCATOR_PATH),
          });
        }
        return; // content element is collected as a whole; no double descent
      }
      for (const child of dom(element as never).children().toArray()) {
        walk(child, nextPath);
      }
    }
  };
  for (const child of dom("body").children().toArray()) {
    walk(child as WalkNode, []);
  }

  // Links: capped during traversal. linksCapped is set ONLY when a safe,
  // outputtable link is actually dropped (the maxLinks+1-th one).
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
    if (links.length >= maxLinks) {
      linksCapped = true; // an outputtable safe link is being dropped
      continue;
    }
    const linkText = normalizeWhitespace(dom(anchor).text()).slice(0, MAX_LINK_TEXT);
    const boundedHref = resolved.length > MAX_HREF ? resolved.slice(0, MAX_HREF) : resolved;
    if (resolved.length > MAX_HREF) {
      auxTruncated = true;
    }
    if (normalizeWhitespace(dom(anchor).text()).length > MAX_LINK_TEXT) {
      auxTruncated = true;
    }
    links.push({ href: boundedHref, text: linkText });
  }

  return {
    title,
    canonicalUrl,
    text: segments.join(""),
    locators,
    links,
    truncated: textTruncated || linksCapped || titleTruncated || locatorsCapped || auxTruncated,
    characterCount,
  };
}

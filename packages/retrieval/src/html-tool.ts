import { Type, type Static } from "typebox";
import * as cheerio from "cheerio";
import {
  ToolExecutionError,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepfield/tool-platform";
import { ResourceStore, zeroFillBuffer } from "./resource-store.js";
import { scopeFromContext } from "./fetch-tools.js";

export const ParseHtmlInputSchema = Type.Object(
  { resourceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ParseHtmlInput = Static<typeof ParseHtmlInputSchema>;

export const HtmlLocatorSchema = Type.Object(
  {
    tag: Type.String({ minLength: 1 }),
    text: Type.String(),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type HtmlLocator = Static<typeof HtmlLocatorSchema>;

export const HtmlLinkSchema = Type.Object(
  {
    href: Type.String({ minLength: 1 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);
export type HtmlLink = Static<typeof HtmlLinkSchema>;

export const ParseHtmlOutputSchema = Type.Object(
  {
    title: Type.String(),
    canonicalUrl: Type.String({ minLength: 1 }),
    text: Type.String(),
    locators: Type.Array(HtmlLocatorSchema),
    links: Type.Array(HtmlLinkSchema),
    truncated: Type.Boolean(),
    characterCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ParseHtmlOutput = Static<typeof ParseHtmlOutputSchema>;

export interface ParseHtmlDeps {
  store: ResourceStore;
  maxChars?: number;
  maxLinks?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_MAX_LINKS = 500;
const CONTENT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "td", "th", "dt", "dd", "caption", "blockquote", "pre", "figcaption", "summary",
]);
const HIDDEN_STYLE_RE = /\b(display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Deterministic UTF-8 decode: BOM-aware, invalid sequences become U+FFFD. */
function decodeHtml(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

function safeResolveUrl(href: string, baseUrl: string): string | undefined {
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

interface ExtractionResult {
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
 * document order. Caps apply DURING construction so a huge page never builds
 * an unbounded intermediate string.
 */
export function extractHtml(html: string, baseUrl: string, maxChars: number, maxLinks: number): ExtractionResult {
  const dom = cheerio.load(html);
  const title = normalizeWhitespace(dom("title").first().text());
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

  interface WalkNode {
    type?: string;
    name?: string;
    parent?: unknown;
  }

  const walk = (element: WalkNode, path: string[]): void => {
    if (textTruncated) {
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
          locators.push({ tag, text: text.slice(0, 200), path: nextPath.join(">") });
        }
        return; // content element is collected as a whole; no double descent
      }
      for (const child of dom(element as never).children().toArray()) {
        walk(child as WalkNode, nextPath);
      }
    }
  };
  for (const child of dom("body").children().toArray()) {
    walk(child as WalkNode, []);
  }

  // Links are capped during traversal (document order, safe schemes only).
  const anchorElements = dom("a[href]").toArray();
  for (const anchor of anchorElements) {
    if (linksCapped) {
      break;
    }
    const href = dom(anchor).attr("href");
    if (href === undefined) {
      continue;
    }
    const resolved = safeResolveUrl(href, baseUrl);
    if (resolved === undefined) {
      continue; // javascript:/data:/file:/malformed are never exposed
    }
    links.push({ href: resolved, text: normalizeWhitespace(dom(anchor).text()).slice(0, 200) });
    if (links.length >= maxLinks) {
      linksCapped = true;
    }
  }

  return {
    title,
    canonicalUrl,
    text: segments.join(""),
    locators,
    links,
    truncated: textTruncated || linksCapped,
    characterCount,
  };
}

export function createParseHtmlDefinition(
  deps: ParseHtmlDeps,
): ToolDefinition<typeof ParseHtmlInputSchema, typeof ParseHtmlOutputSchema> {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLinks = deps.maxLinks ?? DEFAULT_MAX_LINKS;
  return {
    identity: { name: "parse_html", version: 1 },
    label: "Parse HTML",
    description: "Parse a stored HTML resource into normalized text, links and structural locators.",
    inputSchema: ParseHtmlInputSchema,
    outputSchema: ParseHtmlOutputSchema,
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
      try {
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        if (view.metadata.contentType !== "text/html" && view.metadata.contentType !== "application/xhtml+xml") {
          throw new ToolExecutionError("unsupported_content_type");
        }
        const html = decodeHtml(buffer);
        const result = extractHtml(html, view.metadata.finalUrl, maxChars, maxLinks);
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
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        // never leak parser exceptions or raw content
        throw new ToolExecutionError("invalid_input");
      } finally {
        zeroFillBuffer(buffer); // the consumed copy is wiped best-effort
      }
    },
  };
}

export type { ToolRunContext };

import { Type, type Static } from "typebox";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";
import { ResourceStore, safeZeroFill } from "./resource-store.js";
import { scopeFromContext } from "./fetch-tools.js";
import {
  decodeHtml,
  extractHtml,
  validateResourceBaseUrl,
  MAX_CANONICAL,
  MAX_HREF,
  MAX_LINK_TEXT,
  MAX_LOCATORS,
  MAX_LOCATOR_PATH,
  MAX_LOCATOR_TEXT,
  MAX_TITLE,
} from "./html-extraction.js";

export const ParseHtmlInputSchema = Type.Object(
  { resourceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ParseHtmlInput = Static<typeof ParseHtmlInputSchema>;

export const HtmlLocatorSchema = Type.Object(
  {
    tag: Type.String({ minLength: 1 }),
    text: Type.String({ maxLength: MAX_LOCATOR_TEXT }),
    path: Type.String({ minLength: 1, maxLength: MAX_LOCATOR_PATH }),
  },
  { additionalProperties: false },
);
export type HtmlLocator = Static<typeof HtmlLocatorSchema>;

export const HtmlLinkSchema = Type.Object(
  {
    href: Type.String({ minLength: 1, maxLength: MAX_HREF }),
    text: Type.String({ maxLength: MAX_LINK_TEXT }),
  },
  { additionalProperties: false },
);
export type HtmlLink = Static<typeof HtmlLinkSchema>;

export const ParseHtmlOutputSchema = Type.Object(
  {
    title: Type.String({ maxLength: MAX_TITLE }),
    canonicalUrl: Type.String({ minLength: 1, maxLength: MAX_CANONICAL }),
    text: Type.String({ maxLength: 200_000 }),
    locators: Type.Array(HtmlLocatorSchema, { maxItems: MAX_LOCATORS }),
    links: Type.Array(HtmlLinkSchema, { maxItems: 500 }),
    truncated: Type.Boolean(),
    characterCount: Type.Integer({ minimum: 0, maximum: 200_000 }),
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

export function createParseHtmlDefinition(
  deps: ParseHtmlDeps,
): ToolDefinition<typeof ParseHtmlInputSchema, typeof ParseHtmlOutputSchema> {
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLinks = deps.maxLinks ?? DEFAULT_MAX_LINKS;
  assertConfig(maxChars, "maxChars", HARD_MAX_CHARS);
  assertConfig(maxLinks, "maxLinks", HARD_MAX_LINKS);
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
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        // never leak parser exceptions or raw content
        throw new ToolExecutionError("invalid_input");
      } finally {
        safeZeroFill(buffer); // best-effort: a failing zero-fill never changes the result
      }
    },
  };
}

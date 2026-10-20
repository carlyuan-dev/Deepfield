import { Type, type Static } from "typebox";
import { MAX_TITLE, MAX_LOCATORS, MAX_LOCATOR_TEXT, MAX_LOCATOR_PATH, MAX_HREF, MAX_LINK_TEXT, MAX_CANONICAL } from "./html-limits.js";
export const MAX_LINK_FALLBACK_BYTES = 1024 * 1024;

export const LinkInputSchema = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 2048 }) },
  { additionalProperties: false },
);
export type LinkInput = Static<typeof LinkInputSchema>;

export const LinkOutputSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    statusCode: Type.Integer({ minimum: 0 }),
    accessible: Type.Boolean(),
    finalUrl: Type.String({ minLength: 1 }),
    contentType: Type.String(),
    checkedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type LinkOutput = Static<typeof LinkOutputSchema>;
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

export const FetchInputSchema = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 2048 }) },
  { additionalProperties: false },
);
export type FetchInput = Static<typeof FetchInputSchema>;

export const FetchOutputSchema = Type.Object(
  {
    resourceId: Type.String({ minLength: 1 }),
    finalUrl: Type.String({ minLength: 1 }),
    contentType: Type.String({ minLength: 1 }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type FetchOutput = Static<typeof FetchOutputSchema>;
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
    pages: Type.Integer({ minimum: 0, maximum: 200 }),
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
    characterCount: Type.Integer({ minimum: 0, maximum: 400_000 }),
  },
  { additionalProperties: false },
);
export type ParsePdfOutput = Static<typeof ParsePdfOutputSchema>;

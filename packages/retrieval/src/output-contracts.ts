import { Type, type Static } from "typebox";
import { MAX_QUERY_LENGTH, MAX_RESULTS } from "./search-provider.js";

// Data contracts shared with optional capabilities, without loading tool runtimes.
export const MAX_READ_WEBPAGE_TEXT_CHARS = 12_000;
export const ReadWebpageOutputSchema = Type.Object(
  {
    title: Type.String({ maxLength: 2000 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    text: Type.String({ maxLength: MAX_READ_WEBPAGE_TEXT_CHARS }),
    truncated: Type.Boolean(),
    characterCount: Type.Integer({ minimum: 0, maximum: MAX_READ_WEBPAGE_TEXT_CHARS }),
  },
  { additionalProperties: false },
);
export type ReadWebpageOutput = Static<typeof ReadWebpageOutputSchema>;

export const SearchWebResultSchema = Type.Object(
  {
    title: Type.String({ maxLength: 2000 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    snippet: Type.String({ maxLength: 8000 }),
    rank: Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
    provider: Type.String({ minLength: 1, maxLength: 64 }),
    date: Type.Optional(Type.String({ maxLength: 40 })),
    publishedAt: Type.Optional(Type.String({ maxLength: 40 })),
    sourceName: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export const SearchWebOutputSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    provider: Type.String({ minLength: 1, maxLength: 64 }),
    results: Type.Array(SearchWebResultSchema, { maxItems: MAX_RESULTS }),
  },
  { additionalProperties: false },
);
export type SearchWebOutput = Static<typeof SearchWebOutputSchema>;

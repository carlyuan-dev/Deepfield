import { Type, type Static } from "typebox";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";
import {
  SearchProviderError,
  assertValidSearchRequest,
  isValidDateString,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  type SearchProvider,
} from "./search-provider.js";

export const SearchWebInputSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    maxResults: Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
    timeRange: Type.Optional(
      Type.Object(
        {
          from: Type.String({ minLength: 10, maxLength: 40 }),
          to: Type.String({ minLength: 10, maxLength: 40 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type SearchWebInput = Static<typeof SearchWebInputSchema>;

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

function mapProviderError(error: SearchProviderError): ToolExecutionError {
  switch (error.code) {
    case "unauthorized":
      return new ToolExecutionError("authentication_failed");
    case "rate_limited":
      return new ToolExecutionError("rate_limited");
    case "timeout":
      return new ToolExecutionError("timeout");
    case "cancelled":
      return new ToolExecutionError("cancelled");
    case "response_too_large":
      return new ToolExecutionError("response_too_large");
    case "malformed_response":
      return new ToolExecutionError("parse_failed");
    case "redirect_blocked":
      return new ToolExecutionError("redirect_blocked");
    case "network_unavailable":
    case "provider_unavailable":
      return new ToolExecutionError("network_unavailable");
    case "dangerous_url":
      return new ToolExecutionError("url_blocked");
    case "invalid_request":
      return new ToolExecutionError("invalid_input");
  }
}

/**
 * Registers the canonical web_search v1 definition bound to one provider session.
 * Provider payloads never reach the tool output: only normalized fields do,
 * and every provider error is a stable sanitized Tool code.
 */
export function createSearchWebDefinition(
  provider: SearchProvider | ((traceId: string) => SearchProvider),
): ToolDefinition<typeof SearchWebInputSchema, typeof SearchWebOutputSchema> {
  return {
    identity: { name: "web_search", version: 1 },
    label: "Search Web",
    description: "Search the web through a fixed configured search provider.",
    inputSchema: SearchWebInputSchema,
    outputSchema: SearchWebOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "search", countsBytes: false, countsTime: true },
    async execute(input, context, signal) {
      try {
        const activeProvider = typeof provider === "function" ? provider(context.traceId) : provider;
        // the schema enforces shapes; this enforces real dates and from <= to
        // so an illegal range never reaches a remote provider
        if (
          input.timeRange !== undefined &&
          (!isValidDateString(input.timeRange.from) ||
            !isValidDateString(input.timeRange.to) ||
            input.timeRange.from > input.timeRange.to)
        ) {
          throw new ToolExecutionError("invalid_input");
        }
        if (input.timeRange !== undefined && !activeProvider.capabilities.timeRange) {
          throw new ToolExecutionError("invalid_input");
        }
        assertValidSearchRequest({
          query: input.query,
          maxResults: input.maxResults,
          ...(input.timeRange !== undefined ? { timeRange: input.timeRange } : {}),
        });
        const response = await activeProvider.search(
          {
            query: input.query,
            maxResults: input.maxResults,
            ...(input.timeRange !== undefined ? { timeRange: input.timeRange } : {}),
          },
          signal,
        );
        return {
          query: input.query,
          provider: response.provider,
          results: response.results,
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        if (error instanceof SearchProviderError) {
          throw mapProviderError(error);
        }
        throw new ToolExecutionError("executor_failed");
      }
    },
  };
}

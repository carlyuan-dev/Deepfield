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
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
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

const MAX_MODEL_SEARCH_OUTPUT_BYTES = 12_000;
const MAX_MODEL_SEARCH_RESULTS = 8;

function clip(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function formatSearchOutputForModel(output: SearchWebOutput): string {
  const results: Array<Record<string, unknown>> = [];
  const payload = {
    query: output.query,
    provider: output.provider,
    results,
    omittedResults: output.results.length,
  };
  for (const result of output.results.slice(0, MAX_MODEL_SEARCH_RESULTS)) {
    const candidate = {
      title: clip(result.title, 300),
      url: result.url,
      snippet: clip(result.snippet, 900),
      rank: result.rank,
      ...(result.date === undefined ? {} : { date: result.date }),
      ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
      ...(result.sourceName === undefined ? {} : { sourceName: clip(result.sourceName, 200) }),
    };
    results.push(candidate);
    payload.omittedResults = output.results.length - results.length;
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_MODEL_SEARCH_OUTPUT_BYTES) {
      results.pop();
      payload.omittedResults = output.results.length - results.length;
      break;
    }
  }
  return JSON.stringify(payload);
}

function mapProviderError(error: SearchProviderError): ToolExecutionError {
  switch (error.code) {
    case "unauthorized":
      return new ToolExecutionError("authentication_failed");
    case "rate_limited":
      return new ToolExecutionError("rate_limited");
    case "timeout":
      // Provider timeouts are safe for a later, model-directed attempt. The
      // Runner still performs no hidden retry because this tool has maxRetries 0.
      return new ToolExecutionError("timeout", { httpStatus: 408 });
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
  const maxQueryLength = typeof provider === "function" ? MAX_QUERY_LENGTH : provider.capabilities.maxQueryLength ?? MAX_QUERY_LENGTH;
  return {
    identity: { name: "web_search", version: 1 },
    label: "Search Web",
    description: `Search the web through a fixed configured search provider. Keep query within ${maxQueryLength} characters; shorten or split longer queries.`,
    inputSchema: Type.Object({ ...SearchWebInputSchema.properties, query: Type.String({ minLength: 1, maxLength: maxQueryLength }) }, { additionalProperties: false }),
    outputSchema: SearchWebOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "search", countsBytes: false, countsTime: true, commitOn: "external_dispatch" },
    model: { formatOutput: formatSearchOutputForModel },
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
        const maxResults = input.maxResults ?? 5;
        const useNativeTimeRange = input.timeRange !== undefined && activeProvider.capabilities.timeRange;
        const query = input.timeRange !== undefined && !useNativeTimeRange
          ? `${input.query} ${input.timeRange.from} 至 ${input.timeRange.to}`
          : input.query;
        const request = {
          query,
          maxResults,
          ...(useNativeTimeRange ? { timeRange: input.timeRange } : {}),
        };
        assertValidSearchRequest(request, activeProvider.capabilities.maxQueryLength);
        context.markBudgetConsumed?.();
        const response = await activeProvider.search(request, signal);
        return {
          query,
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

import { Type, type Static } from "typebox";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";
import { TransportError, type SafeHttpTransport } from "./http-transport.js";
import { zeroFillBuffer } from "./resource-store.js";

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

export interface LinkToolDeps {
  transport: Pick<SafeHttpTransport, "fetch">;
}

function isAccessible(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

/**
 * HEAD-first link check. Only explicit "HEAD not supported" statuses (405/501)
 * trigger a bounded GET fallback; the fallback body is never buffered into the
 * ResourceStore.
 */
export function createCheckLinkAccessibilityDefinition(
  deps: LinkToolDeps,
): ToolDefinition<typeof LinkInputSchema, typeof LinkOutputSchema> {
  return {
    identity: { name: "check_link_accessibility", version: 1 },
    label: "Check Link Accessibility",
    description: "Check whether a public HTTP(S) link is reachable via HEAD.",
    inputSchema: LinkInputSchema,
    outputSchema: LinkOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "link_check", countsBytes: false, countsTime: true },
    async execute(input, _context, signal) {
      if (signal.aborted) {
        throw new ToolExecutionError("cancelled");
      }
      try {
        const checkedAt = Date.now();
        const head = await deps.transport.fetch(input.url, {
          method: "HEAD",
          signal,
          maxBodyBytes: 0,
        });
        if (head.statusCode === 405 || head.statusCode === 501) {
          const fallback = await deps.transport.fetch(input.url, {
            method: "GET",
            signal,
            maxBodyBytes: MAX_LINK_FALLBACK_BYTES,
          });
          try {
            return {
              url: input.url,
              statusCode: fallback.statusCode,
              accessible: isAccessible(fallback.statusCode),
              finalUrl: fallback.finalUrl,
              contentType: fallback.contentType,
              checkedAt,
            };
          } finally {
            // the fallback body is never stored or surfaced: zero it
            zeroFillBuffer(fallback.body);
          }
        }
        return {
          url: input.url,
          statusCode: head.statusCode,
          accessible: isAccessible(head.statusCode),
          finalUrl: head.finalUrl,
          contentType: head.contentType,
          checkedAt,
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        if (error instanceof TransportError) {
          throw new ToolExecutionError(error.code);
        }
        throw new ToolExecutionError("executor_failed");
      }
    },
  };
}

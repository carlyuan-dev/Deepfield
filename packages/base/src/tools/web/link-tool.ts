import { ToolExecutionError, type ToolDefinition } from "../index.js";
import { LinkInputSchema, LinkOutputSchema } from "../../search/index.js";
import { checkLinkAccessible, TransportError, type LinkCheckDeps } from "../../search/runtime.js";
export { LinkInputSchema, LinkOutputSchema, MAX_LINK_FALLBACK_BYTES, type LinkInput, type LinkOutput } from "../../search/index.js";
export { checkLinkAccessible, type LinkAccessibilityOutcome } from "../../search/runtime.js";
export type LinkToolDeps = LinkCheckDeps;

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
    meter: { category: "link_check", countsBytes: false, countsTime: true, commitOn: "external_dispatch" },
    async execute(input, context, signal) {
      if (signal.aborted) {
        throw new ToolExecutionError("cancelled");
      }
      try {
        const checkedAt = Date.now();
        const outcome = await checkLinkAccessible(deps, input.url, signal, context.markBudgetConsumed);
        return {
          url: input.url,
          statusCode: outcome.statusCode,
          accessible: outcome.accessible,
          finalUrl: outcome.finalUrl,
          contentType: outcome.contentType,
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

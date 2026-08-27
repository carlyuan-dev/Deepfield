import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolEffect, ToolRunContext } from "./definition.js";
import { ToolSet } from "./tool-set.js";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; code: "tool_not_allowed" | "permission_denied" }
  | { decision: "confirmation_required"; confirmationKind: string };

export interface ToolPolicyRequest {
  identity: ToolIdentity;
  effect: ToolEffect;
  input: Record<string, unknown>;
}

const EMPTY_TOOL_SET = new ToolSet([]);

function hostMatches(pattern: string, host: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
}

function inputHost(input: Record<string, unknown>): string | undefined {
  const rawUrl = input["url"];
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed limit check: when a grant configures a maximum, the request must
 * supply an explicit positive integer within that maximum. Missing fields,
 * strings, NaN/Infinity, non-integers, zero/negative and over-limit values all
 * deny; authorization never relies on executor defaults or input schemas.
 */
function isPositiveIntegerAtMost(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

/** Deny-by-default authorization: a grant must match every checked dimension. */
export class ToolPolicy {
  evaluate(request: ToolPolicyRequest, context: ToolRunContext): PolicyDecision {
    const toolSet = context.toolSet ?? EMPTY_TOOL_SET;
    const grant = toolSet.get(request.identity);
    if (grant === undefined) {
      return { decision: "deny", code: "tool_not_allowed" };
    }
    if (grant.actor !== context.actor) {
      return { decision: "deny", code: "permission_denied" };
    }
    if (grant.projectId !== undefined && grant.projectId !== context.projectId) {
      return { decision: "deny", code: "permission_denied" };
    }
    if (grant.effect !== request.effect) {
      return { decision: "deny", code: "permission_denied" };
    }
    if (grant.hostPatterns !== undefined) {
      const host = inputHost(request.input);
      if (host === undefined || !grant.hostPatterns.some((pattern) => hostMatches(pattern, host))) {
        return { decision: "deny", code: "permission_denied" };
      }
    }
    if (grant.maxResults !== undefined) {
      if (!isPositiveIntegerAtMost(request.input["maxResults"], grant.maxResults)) {
        return { decision: "deny", code: "permission_denied" };
      }
    }
    if (grant.maxBytes !== undefined) {
      if (!isPositiveIntegerAtMost(request.input["maxBytes"], grant.maxBytes)) {
        return { decision: "deny", code: "permission_denied" };
      }
    }
    if (grant.confirmationKind !== undefined) {
      const confirmations = context.confirmations ?? new Set<string>();
      if (!confirmations.has(grant.confirmationKind)) {
        return { decision: "confirmation_required", confirmationKind: grant.confirmationKind };
      }
    }
    return { decision: "allow" };
  }
}

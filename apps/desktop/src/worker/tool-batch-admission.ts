import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";

export type PlannedDisposition = "admitted" | "skipped" | "reused";
export type NetworkToolCallName = "web_search" | "read_webpage";

export interface ToolBatchCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface PriorToolResult {
  status: "completed" | "failed";
  retryable?: boolean;
  result?: unknown;
}

export interface PlannedToolCall extends ToolBatchCall {
  disposition: PlannedDisposition;
  normalizedKey?: string;
  priorResult?: PriorToolResult;
  reusedFromId?: string;
}

export interface ToolBatchPlan {
  batchId: string;
  turnIndex: number;
  admitted: PlannedToolCall[];
  skipped: PlannedToolCall[];
  reused: PlannedToolCall[];
  budgetBefore: ToolBudgetSnapshot;
}

export interface PlanToolBatchInput {
  calls: readonly ToolBatchCall[];
  snapshot: ToolBudgetSnapshot;
  priorResults: ReadonlyMap<string, PriorToolResult>;
  turnIndex: number;
}

type BudgetCategory = "search" | "fetch";

function categoryFor(name: string): BudgetCategory | undefined {
  if (name === "web_search") return "search";
  if (name === "read_webpage") return "fetch";
  return undefined;
}

function normalizeAsciiQuery(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizedKey(call: ToolBatchCall): string | undefined {
  if (call.name === "web_search" && typeof call.input.query === "string") {
    return `web_search:${normalizeAsciiQuery(call.input.query)}`;
  }
  if (call.name === "read_webpage" && typeof call.input.url === "string") {
    try {
      return `read_webpage:${new URL(call.input.url).href}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function canReuse(result: PriorToolResult | undefined): boolean {
  return result?.status === "completed" || (result?.status === "failed" && result.retryable !== true);
}

function remaining(snapshot: ToolBudgetSnapshot, category: BudgetCategory): number | undefined {
  const budget = snapshot.categories[category];
  if (budget.exhausted) return 0;
  return budget.remaining;
}

export function planToolBatch({ calls, snapshot, priorResults, turnIndex }: PlanToolBatchInput): ToolBatchPlan {
  const admitted: PlannedToolCall[] = [];
  const skipped: PlannedToolCall[] = [];
  const reused: PlannedToolCall[] = [];
  const remainingByCategory = new Map<BudgetCategory, number | undefined>([
    ["search", remaining(snapshot, "search")],
    ["fetch", remaining(snapshot, "fetch")],
  ]);
  const firstCallByKey = new Map<string, string>();

  for (const call of calls) {
    const key = normalizedKey(call);
    const plannedBase = key === undefined ? { ...call } : { ...call, normalizedKey: key };
    const firstCallId = key === undefined ? undefined : firstCallByKey.get(key);
    const priorResult = key === undefined ? undefined : priorResults.get(key);
    if (firstCallId !== undefined || canReuse(priorResult)) {
      reused.push({
        ...plannedBase,
        disposition: "reused",
        ...(firstCallId === undefined ? {} : { reusedFromId: firstCallId }),
        ...(priorResult === undefined ? {} : { priorResult }),
      });
      continue;
    }

    const category = categoryFor(call.name);
    const available = category === undefined ? undefined : remainingByCategory.get(category);
    if (available !== undefined && available <= 0) {
      skipped.push({ ...plannedBase, disposition: "skipped" });
      continue;
    }

    if (key !== undefined) firstCallByKey.set(key, call.id);
    admitted.push({ ...plannedBase, disposition: "admitted" });
    if (category !== undefined && available !== undefined) remainingByCategory.set(category, available - 1);
  }

  return {
    batchId: `batch-${turnIndex}`,
    turnIndex,
    admitted,
    skipped,
    reused,
    budgetBefore: snapshot,
  };
}

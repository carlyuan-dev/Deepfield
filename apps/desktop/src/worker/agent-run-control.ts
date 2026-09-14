import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";

export type AgentPhase = "deciding" | "executing" | "synthesizing" | "done";
export type NetworkToolName = "web_search" | "read_webpage";

export interface AgentRunPolicy {
  toolDecisionTurns: number;
  reservedSynthesisTurns: 1;
  budgets: {
    webSearch: number;
    readWebpage: number;
  };
  termination: {
    consecutiveEmptyBatches: number;
  };
}

export interface AgentEvidence {
  successfulSearches: number;
  successfulFetches: number;
  knownUrls: ReadonlySet<string>;
  consecutiveEmptyBatches: number;
}

export interface AgentRunControl {
  phase(): AgentPhase;
  deadlineAt(): number;
  turns(): { toolDecisionUsed: number; toolDecisionMax: number; synthesisReserved: 1 };
  budgetSnapshot(): ToolBudgetSnapshot | undefined;
  evidence(): AgentEvidence;
  availableNetworkTools(): NetworkToolName[];
  observeSnapshot(snapshot: ToolBudgetSnapshot): void;
  observeDeadline(now: number): void;
  recordToolDecisionTurn(): void;
  recordBatchEvidence(evidence: {
    successfulSearches?: number;
    successfulFetches?: number;
    knownUrls?: Iterable<string>;
  }): void;
  beginExecution(): void;
  completeBatch(): void;
  complete(): void;
}

export const WEB_CHAT_POLICY: AgentRunPolicy = {
  toolDecisionTurns: 5,
  reservedSynthesisTurns: 1,
  budgets: {
    webSearch: 4,
    readWebpage: 3,
  },
  termination: {
    consecutiveEmptyBatches: 2,
  },
};

function hasCapacity(snapshot: ToolBudgetSnapshot | undefined, category: "search" | "fetch"): boolean {
  if (snapshot === undefined) return false;
  const budget = snapshot.categories[category];
  return !budget.exhausted && budget.remaining !== 0;
}

export function createAgentRunControl(policy: AgentRunPolicy, deadlineAt: number): AgentRunControl {
  let currentPhase: AgentPhase = "deciding";
  let snapshot: ToolBudgetSnapshot | undefined;
  let toolDecisionUsed = 0;
  let successfulSearches = 0;
  let successfulFetches = 0;
  let consecutiveEmptyBatches = 0;
  const knownUrls = new Set<string>();

  const enterSynthesis = (): void => {
    if (currentPhase !== "done") currentPhase = "synthesizing";
  };

  const availableNetworkTools = (): NetworkToolName[] => {
    if (currentPhase !== "deciding") return [];
    const tools: NetworkToolName[] = [];
    if (hasCapacity(snapshot, "search")) tools.push("web_search");
    if (hasCapacity(snapshot, "fetch")) tools.push("read_webpage");
    return tools;
  };

  return {
    phase: () => currentPhase,
    deadlineAt: () => deadlineAt,
    turns: () => ({
      toolDecisionUsed,
      toolDecisionMax: policy.toolDecisionTurns,
      synthesisReserved: policy.reservedSynthesisTurns,
    }),
    budgetSnapshot: () => snapshot,
    evidence: () => ({
      successfulSearches,
      successfulFetches,
      knownUrls: new Set(knownUrls),
      consecutiveEmptyBatches,
    }),
    availableNetworkTools,
    observeSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
      if (currentPhase === "deciding" && availableNetworkTools().length === 0) {
        enterSynthesis();
      }
    },
    observeDeadline(now) {
      if (now >= deadlineAt) enterSynthesis();
    },
    recordToolDecisionTurn() {
      if (currentPhase !== "deciding") return;
      toolDecisionUsed += 1;
      if (toolDecisionUsed >= policy.toolDecisionTurns) enterSynthesis();
    },
    recordBatchEvidence(batchEvidence) {
      const searchCount = batchEvidence.successfulSearches ?? 0;
      const fetchCount = batchEvidence.successfulFetches ?? 0;
      successfulSearches += searchCount;
      successfulFetches += fetchCount;
      for (const url of batchEvidence.knownUrls ?? []) knownUrls.add(url);
      if (searchCount + fetchCount === 0) {
        consecutiveEmptyBatches += 1;
      } else {
        consecutiveEmptyBatches = 0;
      }
    },
    beginExecution() {
      if (currentPhase === "deciding") currentPhase = "executing";
    },
    completeBatch() {
      if (currentPhase !== "executing") return;
      if (consecutiveEmptyBatches >= policy.termination.consecutiveEmptyBatches) {
        enterSynthesis();
        return;
      }
      currentPhase = "deciding";
      if (availableNetworkTools().length === 0) enterSynthesis();
    },
    complete() {
      currentPhase = "done";
    },
  };
}

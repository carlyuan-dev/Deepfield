import type { PiToolSessionProvider } from '../agent/pi-runtime.js';

/** Per-run admission guard, in addition to the existing shared ToolRunner ledger. */
export function withChildSearchBudget(sessions: PiToolSessionProvider, limit: number): PiToolSessionProvider {
  let admitted = 0;
  return {
    ...sessions,
    budgetSnapshot(traceId) {
      const shared = sessions.budgetSnapshot(traceId);
      const remaining = Math.min(shared.categories.search.remaining ?? Infinity, Math.max(0, limit - admitted));
      return { ...shared, categories: { ...shared.categories, search: { ...shared.categories.search, limit, reserved: 0, consumed: admitted, remaining, exhausted: remaining === 0 || shared.categories.search.exhausted } } };
    },
    createAgentTools(context) {
      return sessions.createAgentTools(context).map(tool => tool.name !== 'web_search' ? tool : {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          args[2]?.throwIfAborted();
          // Reserve synchronously before yielding: parallel calls cannot take the same slot.
          if (admitted >= limit) throw new Error('child_search_budget_exhausted');
          admitted += 1;
          return tool.execute(...args);
        },
      });
    },
  };
}

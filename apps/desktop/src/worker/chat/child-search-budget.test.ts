import { expect, it } from 'vitest';
import { createToolRuntime } from '../tools/tool-runtime.js';
import { withChildSearchBudget } from './child-search-budget.js';

it('blocks a third child search before dispatch, preserves another child, and still enforces the shared ceiling', async () => {
  const dispatched: string[] = [];
  const runtime = createToolRuntime({ audit: { start: async () => {}, finish: async () => {} } });
  const provider = { id: 'fixture', capabilities: { timeRange: false }, async search(input: { query: string }) { dispatched.push(input.query); return { provider: 'fixture', results: [] }; } };
  runtime.bindBudgetScope('shared', { categoryCalls: { search: 3 } });
  for (const trace of ['a','b']) { runtime.attachBudgetScope(trace,'shared'); runtime.bindSearchProvider(trace,provider); }
  const a = withChildSearchBudget(runtime,2), b = withChildSearchBudget(runtime,2);
  const call = (session: typeof a, trace: string, id: string, signal = new AbortController().signal) => session.createAgentTools({ traceId: trace, actor: 'child_agent', networkEnabled: true }).find(tool => tool.name === 'web_search')!.execute(id,{ query: id, maxResults: 1 },signal);
  const attempts = await Promise.allSettled([call(a,'a','a1'),call(a,'a','a2'),call(a,'a','a3')]);
  expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(2);
  expect(dispatched).toEqual(['a1','a2']);
  expect(a.budgetSnapshot('a').categories.search.remaining).toBe(0);
  expect(b.budgetSnapshot('b').categories.search.remaining).toBe(1);
  await call(b,'b','b1');
  await expect(call(b,'b','b2')).rejects.toThrow('budget_exceeded');
  expect(dispatched).toEqual(['a1','a2','b1']);
  expect(runtime.budgetSnapshot('shared').categories.search.consumed).toBe(3);
  runtime.releaseTrace('a');runtime.releaseTrace('b');expect(runtime.releaseBudgetScope('shared')).toBe(true);
});

it('does not charge a cancelled call or dispatch any search for an offline child', async () => {
  const runtime = createToolRuntime({ audit: { start: async () => {}, finish: async () => {} } });
  const session = withChildSearchBudget(runtime,1);
  const tool = session.createAgentTools({ traceId: 'cancel', actor: 'child_agent', networkEnabled: true }).find(tool => tool.name === 'web_search')!;
  await expect(tool.execute('cancel', { query: 'test' }, AbortSignal.abort())).rejects.toThrow();
  expect(session.budgetSnapshot('cancel').categories.search.consumed).toBe(0);
  expect(withChildSearchBudget(runtime,0).budgetSnapshot('cancel').categories.search.exhausted).toBe(true);
  runtime.releaseTrace('cancel');
});

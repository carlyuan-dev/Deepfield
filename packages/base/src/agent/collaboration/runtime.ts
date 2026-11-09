import type {
  AgentCoordinator, AgentCoordinatorSnapshot, AgentCoordinatorLimits, AgentOwner, AgentTaskSpec,
  AgentTaskInput, AgentRunView, AgentTaskView, AgentCommandReceipt, AgentCollaborationEvent,
  AgentTaskMessage, AgentRunResult, AgentJson, AgentRunStatus,
} from './index.js';
import { AgentCollaborationError, check, clone, parseAgentCoordinatorSnapshot, safeJson, text } from './validation.js';
export { AgentCollaborationError } from './validation.js';
export interface AgentExecutionRequest {
  scopeId: string; owner: AgentOwner; taskId: string; runId: string; sequence: number;
  spec: AgentTaskSpec; input: AgentTaskInput; previousTranscript?: AgentJson;
  messages: AgentTaskMessage[]; maxAgentTurns: number;
}
export interface AgentExecutionControls {
  signal: AbortSignal;
  /** Called only after the executor actually accepts the messages at a safe boundary. */
  acceptMessages(messageIds: string[]): Promise<void>;
  /** Returning true acknowledges actual acceptance, not mere enqueue into a second mailbox. */
  onMessage(handler: (message: AgentTaskMessage) => boolean | Promise<boolean>): () => void;
  progress(summary: string): Promise<void>;
  saveTranscript(transcript: AgentJson): Promise<void>;
}
export interface AgentCoordinatorOptions {
  scopeId: string; owner: AgentOwner;
  limits: Partial<AgentCoordinatorLimits> & Pick<AgentCoordinatorLimits, 'deadline'>;
  execute(request: AgentExecutionRequest, controls: AgentExecutionControls): Promise<{ result: AgentRunResult; transcript?: AgentJson }>;
  /** Acknowledged durable save. Omit only for an explicitly process-local coordinator. */
  checkpoint?(snapshot: AgentCoordinatorSnapshot): Promise<void>;
  /** A trusted host may supply a validated snapshot. Nonterminal runs become interrupted. */
  snapshot?: AgentCoordinatorSnapshot;
  /** Only the host may set this after validating its persisted HITL handoff receipt. */
  resumeFromHandoff?: true;
  signal?: AbortSignal; now?: () => number; id?: () => string;
  admit?(spec: AgentTaskSpec, input: AgentTaskInput): void | Promise<void>;
  onEvent?(event: AgentCollaborationEvent): void;
}
const terminal = (status: AgentRunStatus) => !['queued','running','cancelling'].includes(status);
const fingerprint = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${fingerprint(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
interface Active {
  controller: AbortController; done: Promise<void>; resolve(): void; settled: boolean;
  handler?: (message: AgentTaskMessage) => boolean | Promise<boolean>;
  delivering: Set<string>; timer?: ReturnType<typeof setTimeout>;
}
/** One owner-bound scope. All durable mutations are serialized; execution remains concurrent. */
export function createAgentCoordinator(options: AgentCoordinatorOptions): AgentCoordinator {
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  text(options.scopeId, 1024); text(options.owner.id, 1024); check(['chat','capability'].includes(options.owner.kind), 'invalid_owner');
  const owner = clone(options.owner);
  const limits: AgentCoordinatorLimits = {
    concurrency: 3, maxTasks: 8, maxRuns: 24, maxRunsPerTask: 3, maxAgentTurns: 8,
    maxMessageChars: 16_000, maxQueuedMessages: 32, maxResultChars: 200_000,
    cancellationGraceMs: 2_000, ...options.limits,
  };
  for (const [key,value] of Object.entries(limits)) check(Number.isSafeInteger(value) && value >= (key === 'cancellationGraceMs' ? 0 : 1), 'invalid_limits');
  let state: AgentCoordinatorSnapshot = options.snapshot ? parseAgentCoordinatorSnapshot(options.snapshot) : {
    version: 1, scopeId: options.scopeId, owner, limits, closed: false,
    taskCount: 0, runCount: 0, cursor: 0, tasks: [], commands: [], events: [],
  };
  check(state.scopeId === options.scopeId && fingerprint(state.owner) === fingerprint(owner), 'owner_mismatch');
  // Reassembly may shorten an execution segment but cannot replenish cumulative limits.
  if (options.snapshot) {
    for (const key of Object.keys(limits) as Array<keyof AgentCoordinatorLimits>) {
      if (key !== 'deadline') limits[key] = Math.min(limits[key], state.limits[key]);
    }
    state.limits = limits;
    if (options.resumeFromHandoff) state.closed = false;
    for (const task of state.tasks) for (const run of task.runs) if (!terminal(run.status)) {
      run.status = 'interrupted'; run.endedAt = now(); run.errorCode = 'execution_interrupted';
      for (const message of run.messages) if (message.status === 'queued') {
        message.status = 'undelivered';
        state.events.push({ scopeId: state.scopeId, taskId: run.taskId, runId: run.runId, cursor: ++state.cursor, timestamp: now(), type: 'message', messageId: message.messageId, messageStatus: 'undelivered' });
      }
      state.events.push({ scopeId: state.scopeId, taskId: run.taskId, runId: run.runId, cursor: ++state.cursor, timestamp: now(), type: 'status', status: 'interrupted' });
    }
  }
  const listeners = new Set<(event: AgentCollaborationEvent) => void>();
  const active = new Map<string, Active>();
  let chain: Promise<unknown> = Promise.resolve();
  let faulted = false; let closePromise: Promise<void> | undefined;
  const serial = <T>(action: () => Promise<T> | T): Promise<T> => {
    const result = chain.then(action); chain = result.catch(() => undefined); return result;
  };
  const publish = (events: AgentCollaborationEvent[]) => {
    for (const event of events) {
      for (const listener of listeners) { try { listener(clone(event)); } catch { /* observation is optional */ } }
      try { options.onEvent?.(clone(event)); } catch { /* observation is optional */ }
    }
  };
  const append = (draft: AgentCoordinatorSnapshot, run: AgentRunView, event: Omit<AgentCollaborationEvent,'scopeId'|'taskId'|'runId'|'cursor'|'timestamp'>) => {
    draft.events.push({ scopeId: draft.scopeId, taskId: run.taskId, runId: run.runId, cursor: ++draft.cursor, timestamp: now(), ...event });
  };
  const stopMessages = (draft: AgentCoordinatorSnapshot, run: AgentRunView) => {
    for (const message of run.messages) if (message.status === 'queued') {
      message.status = 'undelivered'; append(draft, run, { type: 'message', messageId: message.messageId, messageStatus: message.status });
    }
  };
  const failPersistence = () => {
    faulted = true; state.closed = true;
    const before = state.cursor;
    for (const task of state.tasks) for (const run of task.runs) if (!terminal(run.status)) {
      run.status = 'failed'; run.errorCode = 'checkpoint_failed'; run.endedAt = now();
      stopMessages(state, run); append(state, run, { type: 'status', status: run.status });
    }
    for (const [runId, item] of active) { item.controller.abort(); item.timer ??= setTimeout(() => release(runId), limits.cancellationGraceMs); }
    publish(state.events.filter(event => event.cursor > before));
  };
  const commit = async (mutate: (draft: AgentCoordinatorSnapshot) => void) => {
    check(!faulted, 'checkpoint_failed');
    const draft = clone(state); mutate(draft);
    try { await options.checkpoint?.(clone(draft)); }
    catch { failPersistence(); throw new AgentCollaborationError('checkpoint_failed'); }
    const cursor = state.cursor; state = draft; publish(state.events.filter(event => event.cursor > cursor));
  };
  const nextId = (snapshot: AgentCoordinatorSnapshot): string => {
    const value = id(); text(value, 1024);
    check(!snapshot.tasks.some(task => task.taskId === value || task.runs.some(run => run.runId === value || run.messages.some(message => message.messageId === value))), 'id_conflict');
    return value;
  };
  const taskIn = (snapshot: AgentCoordinatorSnapshot, taskId: string): AgentTaskView => {
    const task = snapshot.tasks.find(item => item.taskId === taskId); check(task, 'task_not_found'); return task;
  };
  const runIn = (snapshot: AgentCoordinatorSnapshot, runId: string): AgentRunView => {
    const run = snapshot.tasks.flatMap(task => task.runs).find(item => item.runId === runId); check(run, 'run_not_found'); return run;
  };
  const latest = (snapshot: AgentCoordinatorSnapshot, taskId: string) => taskIn(snapshot, taskId).runs.at(-1)!;
  const open = () => { check(!faulted, 'checkpoint_failed'); check(!state.closed && !options.signal?.aborted, 'scope_closed'); check(now() < limits.deadline, 'deadline_exceeded'); };
  const command = async (commandId: string, payload: unknown, make: (draft: AgentCoordinatorSnapshot) => AgentCommandReceipt) => {
    text(commandId, 1024); safeJson(payload); const key = fingerprint(payload);
    const prior = state.commands.find(command => command.commandId === commandId);
    if (prior) { check(prior.fingerprint === key, 'command_conflict'); return clone(prior.receipt); }
    open(); let receipt!: AgentCommandReceipt;
    await commit(draft => { receipt = make(draft); draft.commands.push({ commandId, fingerprint: key, receipt: clone(receipt) }); });
    return clone(receipt);
  };
  const finish = async (runId: string, status: AgentRunStatus, output?: { result: AgentRunResult; transcript?: AgentJson }, errorCode?: string) => {
    const run = runIn(state, runId); if (terminal(run.status)) return;
    if (run.status === 'cancelling' || options.signal?.aborted || active.get(runId)?.controller.signal.aborted) { status = now() >= limits.deadline ? 'timed_out' : 'cancelled'; output = undefined; }
    if (now() >= limits.deadline && status === 'completed') { status = 'timed_out'; output = undefined; }
    if (output) {
      safeJson(output); check(Object.keys(output).every(key => ['result','transcript'].includes(key)) && Object.keys(output.result).every(key => ['summary','text','sources','limitations'].includes(key)), 'invalid_result'); text(output.result.summary, limits.maxResultChars); text(output.result.text, limits.maxResultChars);
      check(output.result.sources === undefined || Array.isArray(output.result.sources), 'invalid_result'); check(output.result.limitations === undefined || (Array.isArray(output.result.limitations) && output.result.limitations.every(item => typeof item === 'string')), 'invalid_result');
      check(JSON.stringify(output).length <= limits.maxResultChars * 4, 'result_too_large');
    }
    await commit(draft => {
      const target = runIn(draft, runId); target.status = status; target.endedAt = now();
      if (errorCode) target.errorCode = errorCode;
      if (output) { target.result = clone(output.result); if (output.transcript !== undefined) target.transcript = clone(output.transcript); }
      stopMessages(draft, target); append(draft, target, { type: 'status', status });
    });
  };
  const release = (runId: string) => { const item = active.get(runId); if (!item) return; clearTimeout(item.timer); delete item.handler; active.delete(runId); item.resolve(); };
  const accept = (runId: string, ids: string[]) => serial(async () => {
    check(Array.isArray(ids) && ids.every(value => typeof value === 'string'), 'invalid_message');
    const run = runIn(state, runId); check(run.status === 'running' && !active.get(runId)?.controller.signal.aborted, 'run_not_active');
    check(ids.every(id => run.messages.some(message => message.messageId === id && message.status !== 'undelivered')), 'message_not_found');
    await commit(draft => {
      const target = runIn(draft, runId);
      for (const message of target.messages) if (ids.includes(message.messageId) && message.status === 'queued') {
        message.status = 'delivered'; message.deliveredAt = now(); append(draft, target, { type: 'message', messageId: message.messageId, messageStatus: message.status });
      }
    });
  });
  const deliver = (runId: string) => {
    const item = active.get(runId); if (!item?.handler || item.controller.signal.aborted) return;
    for (const message of runIn(state, runId).messages) if (message.status === 'queued' && !item.delivering.has(message.messageId)) {
      item.delivering.add(message.messageId);
      Promise.resolve().then(() => item.handler?.(clone(message))).then(async accepted => {
        if (accepted && !item.controller.signal.aborted && !terminal(runIn(state, runId).status)) await accept(runId, [message.messageId]);
      }).catch(() => { /* Delivery failure leaves an explicit queued/undelivered receipt. */ });
    }
  };
  const start = async (taskId: string, runId: string) => {
    if (faulted || state.closed || options.signal?.aborted) return;
    const run = runIn(state, runId); if (run.status !== 'queued') return;
    if (now() >= limits.deadline) { await finish(runId, 'timed_out', undefined, 'deadline_exceeded'); return; }
    let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; });
    const item: Active = { controller: new AbortController(), done, resolve, settled: false, delivering: new Set() };
    active.set(runId, item);
    try { await commit(draft => { const target = runIn(draft, runId); target.status = 'running'; target.startedAt = now(); append(draft, target, { type: 'status', status: 'running' }); }); }
    catch { release(runId); return; }
    if (options.signal?.aborted || now() >= limits.deadline) { item.controller.abort(); await finish(runId, now() >= limits.deadline ? 'timed_out' : 'cancelled'); release(runId); return; }
    const task = taskIn(state, taskId); const current = runIn(state, runId);
    const previous = [...task.runs].reverse().find(run => run.sequence < current.sequence && run.transcript !== undefined);
    const controls: AgentExecutionControls = {
      signal: item.controller.signal,
      acceptMessages: ids => accept(runId, ids),
      onMessage: handler => { item.handler = handler; deliver(runId); return () => { if (item.handler === handler) delete item.handler; }; },
      progress: summary => serial(async () => {
        text(summary, 4000); if (item.controller.signal.aborted || terminal(runIn(state, runId).status)) return;
        check(state.events.filter(event => event.runId === runId && event.type === 'progress').length < 1000, 'progress_limit');
        await commit(draft => append(draft, runIn(draft, runId), { type: 'progress', summary }));
      }),
      saveTranscript: transcript => serial(async () => {
        safeJson(transcript); check(JSON.stringify(transcript).length <= limits.maxResultChars * 4, 'transcript_too_large');
        check(!item.controller.signal.aborted && !terminal(runIn(state, runId).status), 'run_not_active');
        await commit(draft => { runIn(draft, runId).transcript = clone(transcript); });
      }),
    };
    const request: AgentExecutionRequest = {
      scopeId: state.scopeId, owner: clone(owner), taskId, runId, sequence: current.sequence,
      spec: clone(task.spec), input: clone(current.input), messages: clone(current.messages.filter(message => message.status === 'queued')),
      maxAgentTurns: limits.maxAgentTurns, ...(previous?.transcript !== undefined ? { previousTranscript: clone(previous.transcript) } : {}),
    };
    Promise.resolve().then(() => { check(!item.controller.signal.aborted && !options.signal?.aborted && now() < limits.deadline, 'run_not_active'); return options.execute(request, controls); }).then(
      output => serial(async () => { item.settled = true; try { await finish(runId, 'completed', output); } catch (error) { if (!faulted) await finish(runId, 'failed', undefined, error instanceof AgentCollaborationError ? error.code : 'execution_failed'); } finally { release(runId); pump(); } }),
      error => serial(async () => { item.settled = true; try { if (!faulted) await finish(runId, 'failed', undefined, error instanceof AgentCollaborationError ? error.code : 'execution_failed'); } finally { release(runId); pump(); } }),
    ).catch(() => { release(runId); });
  };
  const pump = () => { void serial(async () => {
    if (state.closed || faulted || options.signal?.aborted) return;
    for (const task of state.tasks) {
      if (active.size >= limits.concurrency) break;
      const run = task.runs.at(-1)!; if (run.status === 'queued') await start(task.taskId, run.runId);
    }
  }).catch(() => undefined); };
  const cancelRun = async (runId: string, timedOut = false) => {
    const run = runIn(state, runId); if (terminal(run.status) || run.status === 'cancelling') return;
    const item = active.get(runId);
    if (!item) { await finish(runId, timedOut ? 'timed_out' : 'cancelled'); return; }
    await commit(draft => { const target = runIn(draft, runId); target.status = 'cancelling'; stopMessages(draft, target); append(draft, target, { type: 'status', status: 'cancelling' }); });
    item.controller.abort();
    if (!item.timer) item.timer = setTimeout(() => { void serial(async () => {
      if (!active.has(runId)) return;
      // An uncooperative executor cannot be allowed to overlap newly admitted work.
      try {
        await commit(draft => {
          draft.closed = true;
          for (const task of draft.tasks) for (const target of task.runs) if (!terminal(target.status)) {
            target.status = target.runId === runId ? (timedOut ? 'timed_out' : 'cancelled') : 'interrupted';
            target.errorCode = 'execution_unsettled'; target.endedAt = now(); stopMessages(draft, target);
            append(draft, target, { type: 'status', status: target.status });
          }
        });
      } finally { for (const [key, activeRun] of active) { activeRun.controller.abort(); release(key); } }
    }).catch(() => release(runId)); }, limits.cancellationGraceMs);
  };
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const scheduleDeadline = () => {
    deadlineTimer = setTimeout(() => {
      if (now() < limits.deadline) { scheduleDeadline(); return; }
      void serial(async () => { for (const task of state.tasks) await cancelRun(task.runs.at(-1)!.runId, true); }).catch(() => undefined);
    }, Math.max(0, Math.min(2_147_483_647, limits.deadline - now())));
    deadlineTimer.unref?.();
  };
  scheduleDeadline();
  const abort = () => { void coordinator.close().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const coordinator: AgentCoordinator = {
    scopeId: state.scopeId,
    spawn: (rawSpec, commandId) => serial(async () => {
      const spec = clone(rawSpec); safeJson(spec); check(Object.keys(spec).every(key => ['title','configurationId','text','context'].includes(key)), 'invalid_spec'); text(spec.title, 1000); text(spec.configurationId, 1024); text(spec.text, limits.maxMessageChars);
      if (!state.commands.some(record => record.commandId === commandId)) { open(); await options.admit?.(clone(spec), clone(spec)); }
      const receipt = await command(commandId, { type: 'spawn', spec }, draft => {
        check(draft.taskCount < limits.maxTasks && draft.runCount < limits.maxRuns, 'task_limit');
        const taskId = nextId(draft); const runId = nextId(draft); check(taskId !== runId, 'id_conflict');
        const input: AgentTaskInput = { text: spec.text, ...(spec.context !== undefined ? { context: clone(spec.context) } : {}) };
        const run: AgentRunView = { taskId, runId, sequence: 1, commandId, input, status: 'queued', createdAt: now(), messages: [] };
        draft.tasks.push({ taskId, spec: clone(spec), runs: [run] }); draft.taskCount++; draft.runCount++; append(draft, run, { type: 'status', status: 'queued' });
        return { taskId, runId, status: 'queued' };
      }); pump(); return receipt;
    }),
    followUp: (taskId, rawInput, commandId) => serial(async () => {
      const input = clone(rawInput); safeJson(input); check(Object.keys(input).every(key => ['text','context'].includes(key)), 'invalid_input'); text(input.text, limits.maxMessageChars);
      if (!state.commands.some(record => record.commandId === commandId)) { open(); await options.admit?.(clone(taskIn(state, taskId).spec), clone(input)); }
      const receipt = await command(commandId, { type: 'followUp', taskId, input }, draft => {
        const task = taskIn(draft, taskId); check(terminal(task.runs.at(-1)!.status) && !active.has(task.runs.at(-1)!.runId), 'task_busy');
        check(draft.runCount < limits.maxRuns && task.runs.length < limits.maxRunsPerTask, 'run_limit');
        const runId = nextId(draft);
        const run: AgentRunView = { taskId, runId, sequence: task.runs.length + 1, commandId, input, status: 'queued', createdAt: now(), messages: [] };
        task.runs.push(run); draft.runCount++; append(draft, run, { type: 'status', status: 'queued' }); return { taskId, runId, status: 'queued' };
      }); pump(); return receipt;
    }),
    send: (taskId, rawText, commandId) => serial(async () => {
      text(rawText, limits.maxMessageChars);
      const receipt = await command(commandId, { type: 'send', taskId, text: rawText }, draft => {
        const run = latest(draft, taskId); check(run.status === 'queued' || run.status === 'running', 'task_not_active');
        check(draft.tasks.flatMap(task => task.runs).flatMap(run => run.messages).filter(message => message.status === 'queued').length < limits.maxQueuedMessages, 'message_limit');
        const messageId = nextId(draft); run.messages.push({ messageId, commandId, text: rawText, status: 'queued', createdAt: now() }); append(draft, run, { type: 'message', messageId, messageStatus: 'queued' });
        return { taskId, runId: run.runId, messageId, status: 'queued' };
      }); deliver(receipt.runId); return receipt;
    }),
    get: taskId => clone(taskIn(state, taskId)), list: () => clone(state.tasks),
    readResult: (reference, read = {}) => {
      check(reference.scopeId === state.scopeId, 'scope_mismatch'); const run = taskIn(state, reference.taskId).runs.find(run => run.runId === reference.runId); check(run?.result, 'result_not_found');
      const offset = read.offset ?? 0; const limit = read.limit ?? Math.min(16_000, limits.maxResultChars);
      check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= limits.maxResultChars, 'invalid_range');
      return { ...clone(run.result), text: run.result.text.slice(offset, offset + limit) };
    },
    wait: async (runIds, cursor, timeoutMs, signal) => {
      check(Array.isArray(runIds) && runIds.length > 0 && runIds.length <= limits.maxRuns, 'invalid_runs');
      runIds.forEach(runId => runIn(state, runId)); check(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= state.cursor && Number.isSafeInteger(timeoutMs) && timeoutMs >= 0, 'invalid_wait');
      const result = (timedOut: boolean) => ({ cursor: state.cursor, events: clone(state.events.filter(event => event.cursor > cursor && runIds.includes(event.runId))), runs: clone(runIds.map(runId => runIn(state, runId))), timedOut });
      const changed = () => state.events.some(event => event.cursor > cursor && runIds.includes(event.runId)) || runIds.every(runId => terminal(runIn(state, runId).status));
      if (signal?.aborted) throw new AgentCollaborationError('wait_aborted');
      if (changed() || timeoutMs === 0) return result(!changed());
      return new Promise((resolve,reject) => {
        const clean = () => { clearTimeout(timer); listeners.delete(listener); signal?.removeEventListener('abort', cancelled); };
        const listener = () => { if (changed()) { clean(); resolve(result(false)); } };
        const cancelled = () => { clean(); reject(new AgentCollaborationError('wait_aborted')); };
        const timer = setTimeout(() => { clean(); resolve(result(true)); }, Math.min(timeoutMs, 2_147_483_647));
        listeners.add(listener); signal?.addEventListener('abort', cancelled, { once: true });
      });
    },
    cancel: async taskId => { const runId = await serial(async () => { const run = latest(state, taskId); await cancelRun(run.runId); return run.runId; }); await active.get(runId)?.done; },
    close: () => {
      closePromise ??= (async () => {
        let error: unknown;
        try {
          await serial(async () => {
            if (!faulted && !state.closed) await commit(draft => { draft.closed = true; });
            for (const task of state.tasks) if (!faulted) await cancelRun(task.runs.at(-1)!.runId);
          });
        } catch (failure) { error = failure; }
        try { await Promise.all([...active.values()].map(item => item.done)); }
        finally { clearTimeout(deadlineTimer); options.signal?.removeEventListener('abort', abort); listeners.clear(); }
        if (error) throw error;
      })(); return closePromise;
    },
    snapshot: () => clone(state),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  if (options.signal?.aborted) abort();
  return coordinator;
}

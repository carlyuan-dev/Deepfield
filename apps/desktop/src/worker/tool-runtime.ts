import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  ToolBudgetError,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import type {
  RetryClock,
  ToolActor,
  ToolAuditSink,
  ToolBudgetLimits,
  ToolDefinition,
  ToolGrant,
} from "@deepfield/tool-platform";
import type { ToolExecutionEvent, ToolExecutionResult, ToolRunRequest } from "@deepfield/contracts";
import {
  MAX_PDF_BYTES,
  ResourceStore,
  SafeHttpTransport,
  UrlPolicy,
  createCheckLinkAccessibilityDefinition,
  createFetchPdfDefinition,
  createFetchUrlDefinition,
  createNodeHttpAdapter,
  createParseHtmlDefinition,
  createParsePdfDefinition,
  createReadWebpageDefinition,
  createSearchWebDefinition,
  type SearchProvider,
} from "@deepfield/retrieval";
import {
  createCalculatorDefinition,
  createConversationToolDefinitions,
  createConvertTimezoneDefinition,
  createCurrentDatetimeDefinition,
  type ConversationReader,
} from "@deepfield/utility-tools";
import type { ToolRuntime } from "./message-loop.js";
import { createPiAgentTools } from "./pi-tool-adapter.js";

class RealRetryClock implements RetryClock {
  now(): number {
    return Date.now();
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const probeInputSchema = Type.Object(
  { text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const probeOutputSchema = Type.Object(
  { text: Type.String() },
  { additionalProperties: false },
);

/** Offline probe tool: no network. Only dev/test/opt-in assemblies register it. */
export function echoProbeDefinition(): ToolDefinition<typeof probeInputSchema, typeof probeOutputSchema> {
  return {
    identity: { name: "echo_probe", version: 1 },
    label: "Echo Probe",
    description: "Offline probe tool that echoes its text input (no network).",
    inputSchema: probeInputSchema,
    outputSchema: probeOutputSchema,
    effect: "project.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: (output) => `probe: ${output.text}` },
    execute: async ({ text }) => ({ text }),
  };
}

const PROBE_GRANTS: Record<ToolActor, boolean> = {
  main_agent: true,
  developer_probe: true,
  capability: false,
  child_agent: false,
  direct_ui: false,
};

/** Actor-scoped trusted ToolSet: one grant per identity, never mixed actors. */
export function createTrustedToolSet(actor: ToolActor, networkEnabled = false): ToolSet {
  const grants: ToolGrant[] = [];
  if (actor === "main_agent") {
    grants.push(
      {
        identity: { name: "get_current_datetime", version: 1 },
        actor,
        effect: "system.read",
      },
      {
        identity: { name: "calculator", version: 1 },
        actor,
        effect: "local.compute",
      },
      {
        identity: { name: "convert_timezone", version: 1 },
        actor,
        effect: "local.compute",
      },
      {
        identity: { name: "list_conversations", version: 1 },
        actor,
        effect: "conversation.read",
      },
      {
        identity: { name: "read_conversation", version: 1 },
        actor,
        effect: "conversation.read",
      },
      {
        identity: { name: "search_conversations", version: 1 },
        actor,
        effect: "conversation.read",
      },
    );
  }
  if (networkEnabled && (actor === "main_agent" || actor === "capability")) grants.push(
    { identity: { name: "web_search", version: 1 }, actor, effect: "network.read.public" },
    { identity: { name: "read_webpage", version: 1 }, actor, effect: "network.read.public" },
  );
  if (PROBE_GRANTS[actor]) {
    grants.push({
      identity: { name: "echo_probe", version: 1 },
      actor,
      effect: "project.read",
    });
  }
  return new ToolSet(grants);
}

export interface TraceBudgetPoolOptions {
  limits: ToolBudgetLimits;
  maxTraces?: number;
  clock?: () => number;
}

/**
 * Strictly bounded per-trace budget pool with an explicit lifecycle. A trace
 * ledger is only ever removed by releaseTrace() (and only when it has no
 * in-flight tokens); idle-but-unreleased traces are never evicted or reset, so
 * a serial research trace cannot bypass maxCalls by getting LRU-evicted. When
 * at capacity, ledgerFor() refuses new traces (the Runner maps the thrown
 * budget error to a safe budget_exceeded result).
 */
export class TraceBudgetPool {
  readonly #entries = new Map<string, ToolBudgetLedger>();
  readonly #traceLimits = new Map<string, ToolBudgetLimits>();
  readonly #limits: ToolBudgetLimits;
  readonly #maxTraces: number;
  readonly #clock: () => number;

  constructor(options: TraceBudgetPoolOptions) {
    this.#limits = options.limits;
    this.#maxTraces = options.maxTraces ?? 64;
    this.#clock = options.clock ?? Date.now;
  }

  ledgerFor(traceId: string): ToolBudgetLedger {
    const existing = this.#entries.get(traceId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.#entries.size >= this.#maxTraces) {
      throw new ToolBudgetError("tool budget exceeded: max traces");
    }
    const ledger = new ToolBudgetLedger(this.#traceLimits.get(traceId) ?? this.#limits, this.#clock);
    this.#entries.set(traceId, ledger);
    return ledger;
  }

  initializeTrace(traceId: string, limits: ToolBudgetLimits): void {
    if (this.#entries.has(traceId)) throw new ToolBudgetError("trace budget already initialized");
    this.#traceLimits.set(traceId, limits);
  }

  /**
   * Explicit end-of-trace: removes the ledger only when no token is in flight.
   * Returns false (and keeps the ledger) while the trace is active so a budget
   * is never silently reset under an in-flight execution.
   */
  releaseTrace(traceId: string): boolean {
    const ledger = this.#entries.get(traceId);
    if (ledger === undefined) {
      this.#traceLimits.delete(traceId);
      return true;
    }
    if (ledger.activeCount() > 0) {
      return false;
    }
    this.#entries.delete(traceId);
    this.#traceLimits.delete(traceId);
    return true;
  }

  size(): number {
    return this.#entries.size;
  }

  has(traceId: string): boolean {
    return this.#entries.has(traceId);
  }
}

export class SearchSessionRegistry {
  readonly #providers = new Map<string, SearchProvider>();

  bind(traceId: string, provider: SearchProvider): void {
    if (!traceId || this.#providers.has(traceId)) throw new Error("search session is already bound");
    this.#providers.set(traceId, provider);
  }

  get(traceId: string): SearchProvider {
    const provider = this.#providers.get(traceId);
    if (provider === undefined) throw new Error("search session is not bound");
    return provider;
  }

  release(traceId: string): void { this.#providers.delete(traceId); }
  has(traceId: string): boolean { return this.#providers.has(traceId); }
}

export const TRACE_BUDGET_LIMITS: ToolBudgetLimits = {
  maxCalls: 12,
  categoryCalls: { search: 1, link_check: 3, fetch: 3 },
};

export interface ToolRuntimeOptions {
  audit: ToolAuditSink;
  conversationReader?: ConversationReader;
  retrieval?: {
    store?: ResourceStore;
    transport?: Pick<SafeHttpTransport, "fetch">;
  };
  registerProbe?: boolean;
  maxTraces?: number;
}

export interface PiToolContext {
  traceId: string;
  actor: ToolActor;
  projectId?: string;
  networkEnabled?: boolean;
}

export interface UtilityToolRuntime extends ToolRuntime {
  registry: ToolRegistry;
  policy: ToolPolicy;
  runner: ToolRunner;
  audit: ToolAuditSink;
  run(
    request: ToolRunRequest,
    emit: (event: ToolExecutionEvent) => void,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
  createAgentTools(context: PiToolContext): ReturnType<typeof createPiAgentTools>;
  traceLedgerCount(): number;
  tracePool: TraceBudgetPool;
  searchSessions: SearchSessionRegistry;
  bindSearchProvider(traceId: string, provider: SearchProvider, limits?: ToolBudgetLimits): void;
  /** Explicit end-of-trace; false while the trace has in-flight tokens. */
  releaseTrace(traceId: string): boolean;
}

export function createToolRuntime(options: ToolRuntimeOptions): UtilityToolRuntime {
  const registry = new ToolRegistry();
  const resourceStore = options.retrieval?.store ?? new ResourceStore();
  const transport =
    options.retrieval?.transport ??
    new SafeHttpTransport({
      policy: new UrlPolicy(),
      adapter: createNodeHttpAdapter(),
      maxBodyBytes: MAX_PDF_BYTES,
    });
  registry.register(createCurrentDatetimeDefinition());
  registry.register(createCalculatorDefinition());
  registry.register(createConvertTimezoneDefinition());
  if (options.conversationReader !== undefined) {
    const [listConversations, readConversation, searchConversations] =
      createConversationToolDefinitions(options.conversationReader);
    registry.register(listConversations);
    registry.register(readConversation);
    registry.register(searchConversations);
  }
  registry.register(createFetchUrlDefinition({ transport, store: resourceStore }));
  registry.register(createFetchPdfDefinition({ transport, store: resourceStore }));
  registry.register(createParseHtmlDefinition({ store: resourceStore }));
  registry.register(createParsePdfDefinition({ store: resourceStore }));
  registry.register(createReadWebpageDefinition({ transport, store: resourceStore }));
  registry.register(createCheckLinkAccessibilityDefinition({ transport }));
  const searchSessions = new SearchSessionRegistry();
  registry.register(createSearchWebDefinition((traceId) => searchSessions.get(traceId)));
  if (options.registerProbe === true) {
    registry.register(echoProbeDefinition());
  }
  registry.freeze();
  const policy = new ToolPolicy();
  const clock = new RealRetryClock();
  const tracePool = new TraceBudgetPool({
    limits: TRACE_BUDGET_LIMITS,
    ...(options.maxTraces !== undefined ? { maxTraces: options.maxTraces } : {}),
    clock: () => clock.now(),
  });
  const runner = new ToolRunner({
    registry,
    policy,
    budget: new ToolBudgetLedger({}, () => clock.now()),
    audit: options.audit,
    clock,
    budgetForTrace: (traceId) => tracePool.ledgerFor(traceId),
    globalConcurrency: 4,
    networkToolConcurrency: 2,
  });
  const toolSetByActor = new Map<ToolActor, ToolSet>();
  for (const actor of ["main_agent", "capability", "child_agent", "direct_ui", "developer_probe"] as const) {
    toolSetByActor.set(actor, createTrustedToolSet(actor));
  }
  return {
    registry,
    policy,
    runner,
    audit: options.audit,
    tracePool,
    searchSessions,
    bindSearchProvider(traceId, provider, limits) {
      if (limits !== undefined) tracePool.initializeTrace(traceId, limits);
      searchSessions.bind(traceId, provider);
    },
    traceLedgerCount: () => tracePool.size(),
    releaseTrace(traceId) {
      const released = tracePool.releaseTrace(traceId);
      if (released) {
        resourceStore.releaseTrace(traceId);
        searchSessions.release(traceId);
      }
      return released;
    },
    async run(request, emit, signal): Promise<ToolExecutionResult> {
      return runner.execute(
        {
          executionId: request.executionId,
          traceId: request.traceId,
          tool: request.tool,
          input: request.input,
        },
        {
          traceId: request.traceId,
          actor: request.actor,
          ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        toolSet: toolSetByActor.get(request.actor) ?? createTrustedToolSet(request.actor),
        },
        signal,
        emit,
      );
    },
    createAgentTools(context) {
      return createPiAgentTools(registry, runner, {
        traceId: context.traceId,
        actor: context.actor,
        ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
        toolSet: context.networkEnabled === true
          ? createTrustedToolSet(context.actor, true)
          : toolSetByActor.get(context.actor) ?? createTrustedToolSet(context.actor),
      });
    },
  };
}

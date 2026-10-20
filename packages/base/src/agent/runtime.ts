import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { LlmRuntimeSnapshot } from "../config/llm.js";
import type { ModelGatewayError } from "../model/errors.js";
import type { ModelRequestObserver } from "../model/observation.js";
import type { AgentHandoff, PiAgentRequest, PiExecutionEvent } from "./index.js";
import { PiAgentError } from "./errors.js";
import { finalToolFreeAnswer, hasProviderFailure, hasToolCalls, validateFinalAnswer } from "./message-utils.js";

export { PiAgentError } from "./errors.js";
export * from "./message-utils.js";

export interface PiSession {
  model: Model<Api>;
  streamFn: StreamFn;
  getModelFailure?(): ModelGatewayError | undefined;
}

export interface PiAgentHandle {
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  abort(): void;
  followUp(message: AgentMessage): void;
  prompt(message: string): Promise<void>;
}

export interface PiRuntime<Origin = unknown, Phase extends string = string> {
  createSession(snapshot: LlmRuntimeSnapshot, observer?: ModelRequestObserver<Origin, Phase>): PiSession | undefined;
  createAgent(options: AgentOptions): PiAgentHandle;
}

export interface PiRunOptions {
  maxAgentTurns: number;
  handoff?: AgentHandoff;
  getModelFailure?: PiSession["getModelFailure"];
}

export type PiRunResult = { status: "completed"; text: string } | { status: "handed_off" };

/** One run. Scenario hooks can narrow tools/context and stop earlier, never raise limits. */
export function createPiAgentRun(
  options: AgentOptions,
  limits: PiRunOptions,
  createAgent: (options: AgentOptions) => PiAgentHandle = options => new Agent(options),
): PiAgentHandle & { run(prompt: string, signal: AbortSignal): Promise<PiRunResult> } {
  if (!Number.isSafeInteger(limits.maxAgentTurns) || limits.maxAgentTurns < 1) {
    throw new RangeError("maxAgentTurns must be a positive safe integer");
  }
  const maxAgentTurns = limits.maxAgentTurns;
  let turns = 0;
  let finalTurn = maxAgentTurns === 1;
  let started = false;
  let ended = false;
  let consumed = false;
  let failed = false;
  let messages: AgentMessage[] = [];
  let runSignal: AbortSignal | undefined;
  // Preserve actual tool objects, so a hook cannot replace an admitted implementation.
  const admitted = new Map((options.initialState?.tools ?? []).map(tool => [tool.name, tool]));
  const narrowTools = (tools: NonNullable<AgentOptions["initialState"]>["tools"]) => {
    const names = new Set((tools ?? []).map(tool => tool.name));
    for (const name of admitted.keys()) if (finalTurn || !names.has(name)) admitted.delete(name);
    return [...admitted.values()];
  };
  const agent = createAgent({
    ...options,
    initialState: { ...options.initialState, tools: narrowTools(options.initialState?.tools) },
    toolExecution: "sequential",
    streamFn: (model, context, streamOptions) => {
      const tools = narrowTools(context.tools as NonNullable<AgentOptions["initialState"]>["tools"]);
      return options.streamFn(model, { ...context, tools }, {
        ...streamOptions,
        ...(tools.length === 0 ? { toolChoice: "none" as const } : {}),
      });
    },
    beforeToolCall: async (context, signal) => {
      // Let the upper layer record its handoff audit before enforcing the block.
      const decision = await options.beforeToolCall?.(context, signal);
      if (runSignal?.aborted || signal?.aborted || limits.handoff?.isRequested()) {
        return { ...decision, block: true, reason: decision?.reason ?? "handoff_pending", terminate: true };
      }
      if (finalTurn || !admitted.has(context.toolCall.name)) {
        return { block: true, reason: "tool_unavailable", terminate: true };
      }
      return decision;
    },
    prepareNextTurnWithContext: async (context, signal) => {
      // Pi invokes this exactly once after each completed turn. Keep the
      // counter private: scenario hooks may prune either mutable message array.
      turns += 1;
      finalTurn ||= turns >= maxAgentTurns - 1;
      const update = options.prepareNextTurnWithContext
        ? await options.prepareNextTurnWithContext(context, signal)
        : await options.prepareNextTurn?.(signal);
      const next = update?.context ?? context.context;
      return { ...update, context: { ...next, tools: narrowTools(next.tools) } };
    },
    shouldStopAfterTurn: async (context, signal) => {
      const stop = await options.shouldStopAfterTurn?.(context, signal);
      return Boolean(runSignal?.aborted || signal?.aborted || limits.handoff?.isRequested() ||
        turns >= maxAgentTurns || stop);
    },
  });
  const observe = (event: AgentEvent) => {
    if (event.type === "agent_start") started = true;
    if (event.type === "message_end" && event.message.role === "assistant") failed ||= hasProviderFailure([event.message]);
    if (event.type === "agent_end") { ended = true; messages = event.messages; failed ||= hasProviderFailure(messages); }
  };
  const run = async (prompt: string, signal: AbortSignal): Promise<PiRunResult> => {
    if (consumed) throw new Error("Pi agent run is single-use");
    consumed = true;
    runSignal = signal;
    if (signal.aborted) {
      agent.abort();
      throw new PiAgentError("stream_failed", "agent execution aborted before start");
    }
    const unsubscribe = agent.subscribe(observe);
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      try { await agent.prompt(prompt); }
      catch (error) {
        if (error instanceof PiAgentError) throw error;
        throw new PiAgentError(signal.aborted ? "stream_failed" : "provider_failed", "agent execution failed");
      }
      if (signal.aborted) throw new PiAgentError("stream_failed", "agent execution aborted");
      if (failed) throw new PiAgentError(limits.getModelFailure?.()?.stage === "response_body" ? "stream_failed" : "provider_failed", "agent execution failed");
      if (!started || !ended) throw new PiAgentError("incomplete_lifecycle", "agent finished without a complete start/end sequence");
      if (limits.handoff?.isRequested()) return { status: "handed_off" };
      const last = [...messages].reverse().find(message => message.role === "assistant");
      const answer = validateFinalAnswer(finalToolFreeAnswer(messages), prompt, last !== undefined && hasToolCalls(last));
      if (!answer.ok) throw new PiAgentError(answer.code, "agent finished without a final answer");
      return { status: "completed", text: answer.text };
    } finally { signal.removeEventListener("abort", abort); unsubscribe(); }
  };
  return {
    subscribe: listener => agent.subscribe(listener),
    abort: () => agent.abort(),
    followUp: message => agent.followUp(message),
    prompt: async prompt => { await run(prompt, new AbortController().signal); },
    run,
  };
}

export interface PiAgentExecutionRequest extends PiAgentRequest {
  session: PiSession;
  tools?: NonNullable<AgentOptions["initialState"]>["tools"];
  messages?: AgentMessage[];
  getApiKey?: AgentOptions["getApiKey"];
  handoff?: AgentHandoff;
}

/** Ordinary model/tool execution, with no Chat memory or research strategy. */
export function createPiAgentExecutor(createAgent?: (options: AgentOptions) => PiAgentHandle) {
  return {
    async run(request: PiAgentExecutionRequest, emit: (event: PiExecutionEvent) => void, signal: AbortSignal): Promise<void> {
      const handoffSkipped = new Set<string>();
      const agent = createPiAgentRun({
        initialState: { systemPrompt: request.systemPrompt, model: request.session.model, messages: request.messages ?? [], tools: request.tools ?? [], thinkingLevel: "off" },
        streamFn: request.session.streamFn,
        beforeToolCall: async context => {
          if (request.handoff?.isRequested()) handoffSkipped.add(context.toolCall.id);
          return undefined;
        },
        ...(request.getApiKey ? { getApiKey: request.getApiKey } : {}),
      }, { maxAgentTurns: request.maxAgentTurns, ...(request.handoff ? { handoff: request.handoff } : {}), ...(request.session.getModelFailure ? { getModelFailure: request.session.getModelFailure } : {}) }, createAgent);
      let text = "";
      let suppress = false;
      let started = false;
      const reset = () => { suppress = true; if (text) { text = ""; emit({ requestId: request.requestId, type: "text_reset" }); } };
      const unsubscribe = agent.subscribe(event => {
        if (event.type === "agent_start" && !started) { started = true; emit({ requestId: request.requestId, type: "started" }); }
        if (event.type === "message_start" && event.message.role === "assistant") suppress = false;
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type.startsWith("toolcall_")) reset();
          if (!suppress && event.assistantMessageEvent.type === "text_delta") {
            text += event.assistantMessageEvent.delta;
            emit({ requestId: request.requestId, type: "text_delta", delta: event.assistantMessageEvent.delta });
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant" && hasToolCalls(event.message)) reset();
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          if (event.type === "tool_execution_end" && handoffSkipped.has(event.toolCallId)) {
            emit({ requestId: request.requestId, type: "tool_activity", callKey: event.toolCallId, toolCallId: event.toolCallId, name: event.toolName, status: "skipped", errorCode: "handoff_pending", budgetConsumed: false });
            return;
          }
          emit({
            requestId: request.requestId, type: "tool_activity",
            callKey: event.toolCallId, toolCallId: event.toolCallId, name: event.toolName,
            status: event.type === "tool_execution_start" ? "running" : event.isError ? "failed" : "completed",
          });
        }
      });
      try {
        const result = await agent.run(request.prompt, signal);
        if (result.status === "handed_off") { emit({ requestId: request.requestId, type: "handed_off" }); return; }
        if (!text) emit({ requestId: request.requestId, type: "text_delta", delta: result.text });
        else if (result.text.startsWith(text) && result.text.length > text.length) emit({ requestId: request.requestId, type: "text_delta", delta: result.text.slice(text.length) });
        emit({ requestId: request.requestId, type: "completed", text: result.text });
      } finally { unsubscribe(); }
    },
  };
}

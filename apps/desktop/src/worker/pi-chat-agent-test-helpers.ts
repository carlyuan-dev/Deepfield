import type { AgentOptions, AgentEvent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ChatRequestOptions,
} from "@deepfield/contracts";
import type { PiAgentHandle, PiRuntime } from "./pi-chat-agent.js";
import type { ChatAgent } from "./message-loop.js";

export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function assistant(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 1000,
    ...overrides,
  };
}

export function agentEnd(messages: AssistantMessage[]): AgentEvent {
  return { type: "agent_end", messages };
}

export function textDelta(delta: string): AgentEvent {
  return {
    type: "message_update",
    message: assistant(""),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistant(delta) },
  };
}

export function thinkingDelta(): AgentEvent {
  return {
    type: "message_update",
    message: assistant(""),
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "思考",
      partial: assistant(""),
    },
  };
}

export const stubModel = {
  id: "deepseek-v4-flash",
  api: "openai-completions",
  provider: "deepseek",
} as unknown as Model<Api>;

export class FakePiAgent implements PiAgentHandle {
  aborted = false;
  promptedWith: string | undefined;
  promptCallCount = 0;
  receivedOptions: AgentOptions | undefined;
  listenerCount = 0;
  private listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private signalController = new AbortController();
  private resolvePending: (() => void) | undefined;

  constructor(
    private readonly script: { events: AgentEvent[]; pending?: boolean; reject?: Error },
  ) {}

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    this.listenerCount = this.listeners.size;
    return () => {
      this.listeners.delete(listener);
      this.listenerCount = this.listeners.size;
    };
  }

  // Mirrors real Pi Agent.abort(): it only interrupts an active run. Calling it
  // before prompt() must not poison a later prompt, so we never abort the
  // internal signal here; pending runs are released via resolvePending.
  abort(): void {
    this.aborted = true;
    this.resolvePending?.();
  }

  async prompt(input: string): Promise<void> {
    this.promptCallCount += 1;
    this.promptedWith = input;
    if (this.script.pending) {
      await new Promise<void>((resolve) => {
        this.resolvePending = resolve;
      });
    }
    for (const event of this.script.events) {
      for (const listener of [...this.listeners]) {
        await listener(event, this.signalController.signal);
      }
    }
    if (this.script.reject) {
      throw this.script.reject;
    }
  }
}

export function makeRuntime(agent: FakePiAgent, model?: Model<Api>): PiRuntime {
  return {
    createSession: () =>
      model ? { model, streamFn: (() => undefined) as never } : undefined,
    createAgent: (options) => {
      agent.receivedOptions = options;
      return agent;
    },
  };
}

export function request(options?: ChatRequestOptions): AgentWorkerRequest {
  return {
    requestId: "req-1",
    kind: "chat.prompt",
    prompt: "当前问题",
    context: {
      projectId: "p1",
      conversationId: "c1",
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "历史用户", timestamp: 1 },
        { role: "assistant", content: "历史助手", timestamp: 2 },
      ],
    },
    options: options ?? { webSearch: false },
    apiKey: "sk-secret-test-key",
    modelId: DEFAULT_DEEPSEEK_MODEL_ID,
  };
}

export async function capture(
  agent: ChatAgent,
  signal?: AbortSignal,
): Promise<{ events: AgentWorkerEvent[]; error: Error | undefined }> {
  const events: AgentWorkerEvent[] = [];
  let error: Error | undefined;
  try {
    await agent.run(request(), (event) => events.push(event), signal ?? new AbortController().signal);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { events, error };
}

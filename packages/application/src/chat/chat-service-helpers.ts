import type { AgentWorkerEvent, AgentWorkerRequest, Conversation, LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";
import type { AgentWorkerPort, RuntimeProfileResolver } from "../ports.js";
import type { TestDb } from "../testing/application-test-helpers.js";
import { ChatService } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";

export class FakeWorker implements AgentWorkerPort {
  requests: AgentWorkerRequest[] = [];
  onSend: ((request: AgentWorkerRequest) => void) | undefined;

  constructor(
    private readonly behavior: {
      events?: (request: AgentWorkerRequest) => AgentWorkerEvent[];
      sendError?: Error;
      iterateError?: Error;
      postTerminalEvents?: AgentWorkerEvent[];
      neverEnds?: boolean;
    } = {},
  ) {}

  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    if (this.behavior.sendError) {
      throw this.behavior.sendError;
    }
    this.requests.push(request);
    this.onSend?.(request);
    const events = this.behavior.events?.(request) ?? [];
    const iterateError = this.behavior.iterateError;
    const postTerminal = this.behavior.postTerminalEvents ?? [];
    const neverEnds = this.behavior.neverEnds === true;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
        if (iterateError) {
          throw iterateError;
        }
        for (const event of postTerminal) {
          yield event;
        }
        if (neverEnds) {
          await new Promise<void>(() => {});
        }
      },
    };
  }
}

export function makeSecrets(key: string | undefined): RuntimeProfileResolver & { getCalls: number; searchCalls: number } {
  const reader: RuntimeProfileResolver & { getCalls: number; searchCalls: number } = {
    getCalls: 0,
    searchCalls: 0,
    resolveActiveLlm: async (): Promise<LlmRuntimeSnapshot> => {
      reader.getCalls += 1;
      if (!key?.trim()) throw new Error("missing");
      return { id: "llm-1", name: "Test", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128000, apiKey: key };
    },
    resolveActiveSearch: async (): Promise<SearchRuntimeSnapshot> => { reader.searchCalls += 1; return { id: "search-1", name: "Search", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: { searchEngine: "search_std" }, apiKey: "search-key" }; },
  };
  return reader;
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function chatEvent(
  requestId: string,
  type: "started" | "completed" | "failed",
  payload?: string,
): AgentWorkerEvent {
  switch (type) {
    case "started":
      return { requestId, type: "started" };
    case "completed":
      return { requestId, type: "completed", text: payload ?? "" };
    case "failed":
      return { requestId, type: "failed", code: payload ?? "error", message: "boom" };
  }
}

export function makeChatService(
  db: TestDb,
  worker: FakeWorker,
  key = "sk-configured",
): { service: ChatService; finished: { promise: Promise<void>; resolve: () => void } } {
  const contextBuilder = new ContextBuilder(db.repos);
  const finished = deferred();
  const service = new ChatService(db.repos, contextBuilder, makeSecrets(key), worker, {
    onConsumptionFinished: () => finished.resolve(),
  });
  return { service, finished };
}

export function makeConversation(db: TestDb): Conversation {
  return db.repos.conversations.create();
}

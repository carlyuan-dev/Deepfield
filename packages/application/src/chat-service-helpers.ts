import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import type { AgentWorkerPort, SecretReader } from "./ports.js";
import type { TestDb } from "./application-test-helpers.js";
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

export function makeSecrets(key: string | undefined): SecretReader & { getCalls: number } {
  const reader: SecretReader & { getCalls: number } = {
    getCalls: 0,
    get: (name: string): string | undefined => {
      reader.getCalls += 1;
      return name === "deepseek.apiKey" ? key : undefined;
    },
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
  requestIdFactory: () => string = () => "req-1",
): { service: ChatService; finished: { promise: Promise<void>; resolve: () => void } } {
  const contextBuilder = new ContextBuilder(db.repos);
  const finished = deferred();
  const service = new ChatService(db.repos, contextBuilder, makeSecrets(key), worker, {
    requestIdFactory,
    onConsumptionFinished: () => finished.resolve(),
  });
  return { service, finished };
}

export function makeProject(db: TestDb) {
  const project = db.repos.projects.createWithConversation({
    industry: "人形机器人",
    scope: {},
    launchSource: "direct-ui",
  });
  const conversation = db.repos.conversations.listByProject(project.id)[0]!;
  return { project, conversation };
}

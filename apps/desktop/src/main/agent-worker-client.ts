import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";

export interface MessageEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}

const MAX_PENDING_EVENTS = 1000;

export class AgentProtocolError extends Error {
  constructor() {
    super("agent worker sent an invalid protocol event");
    this.name = "AgentProtocolError";
  }
}

export class AgentWorkerExitedError extends Error {
  constructor(exitCode: number) {
    super(`agent worker exited unexpectedly with code ${exitCode}`);
    this.name = "AgentWorkerExitedError";
  }
}

export class AgentWorkerQueueOverflowError extends Error {
  constructor() {
    super("agent worker event queue overflow");
    this.name = "AgentWorkerQueueOverflowError";
  }
}

interface PendingStream {
  queue: AgentWorkerEvent[];
  waiters: Array<{
    resolve: (result: IteratorResult<AgentWorkerEvent>) => void;
    reject: (error: Error) => void;
  }>;
  error: Error | undefined;
  terminalSeen: boolean;
}

type StreamIteratorResult = IteratorResult<AgentWorkerEvent>;

function isTerminal(event: AgentWorkerEvent): boolean {
  return event.type === "completed" || event.type === "failed";
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null) {
    const requestId = (value as { requestId?: unknown }).requestId;
    if (typeof requestId === "string") {
      return requestId;
    }
  }
  return undefined;
}

export class AgentWorkerClient {
  private readonly pending = new Map<string, PendingStream>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeExit: () => void;
  private disposed = false;
  private exited = false;
  private exitCode = 0;

  constructor(private readonly endpoint: MessageEndpoint) {
    this.unsubscribeMessage = endpoint.onMessage((value) => this.handleMessage(value));
    this.unsubscribeExit = endpoint.onExit((code) => this.handleExit(code));
  }

  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    if (this.disposed) {
      throw new Error("agent worker client is disposed");
    }
    if (this.exited) {
      throw new AgentWorkerExitedError(this.exitCode);
    }
    if (this.pending.has(request.requestId)) {
      throw new Error(`duplicate request id: ${request.requestId}`);
    }
    const stream: PendingStream = {
      queue: [],
      waiters: [],
      error: undefined,
      terminalSeen: false,
    };
    this.pending.set(request.requestId, stream);
    try {
      this.endpoint.postMessage(request);
    } catch (error) {
      this.pending.delete(request.requestId);
      throw error;
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(stream),
        return: () => {
          this.cleanup(request.requestId, stream);
          return Promise.resolve({ value: undefined, done: true } as StreamIteratorResult);
        },
        throw: () => {
          this.cleanup(request.requestId, stream);
          return Promise.resolve({ value: undefined, done: true } as StreamIteratorResult);
        },
      }),
    };
  }

  pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeMessage();
    this.unsubscribeExit();
    const error = new Error("agent worker client disposed");
    for (const [requestId, stream] of [...this.pending]) {
      this.close(requestId, stream, error);
    }
  }

  private handleMessage(value: unknown): void {
    if (this.disposed) {
      return;
    }
    if (!Value.Check(AgentWorkerEventSchema, value)) {
      const requestId = safeRequestId(value);
      if (requestId !== undefined) {
        const stream = this.pending.get(requestId);
        if (stream) {
          this.close(requestId, stream, new AgentProtocolError());
        }
      }
      return;
    }
    const requestId = value.requestId;
    const stream = this.pending.get(requestId);
    if (!stream) {
      return;
    }
    this.push(requestId, stream, value);
  }

  private push(requestId: string, stream: PendingStream, event: AgentWorkerEvent): void {
    if (stream.error || stream.terminalSeen) {
      return;
    }
    const terminal = isTerminal(event);
    const waiter = stream.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      if (terminal) {
        stream.terminalSeen = true;
        this.cleanup(requestId, stream);
        for (const pendingWaiter of stream.waiters.splice(0)) {
          pendingWaiter.resolve({ value: undefined, done: true });
        }
      }
      return;
    }
    if (stream.queue.length >= MAX_PENDING_EVENTS) {
      this.close(requestId, stream, new AgentWorkerQueueOverflowError());
      return;
    }
    stream.queue.push(event);
    if (terminal) {
      stream.terminalSeen = true;
      this.cleanup(requestId, stream);
    }
  }

  private next(stream: PendingStream): Promise<StreamIteratorResult> {
    if (stream.error) {
      return Promise.reject(stream.error);
    }
    if (stream.queue.length > 0) {
      return Promise.resolve({ value: stream.queue.shift()!, done: false });
    }
    if (stream.terminalSeen) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      stream.waiters.push({ resolve, reject });
    });
  }

  private close(requestId: string, stream: PendingStream, error: Error): void {
    stream.error = error;
    stream.queue = [];
    for (const waiter of stream.waiters.splice(0)) {
      waiter.reject(error);
    }
    this.pending.delete(requestId);
  }

  private cleanup(requestId: string, stream: PendingStream): void {
    if (this.pending.get(requestId) === stream) {
      this.pending.delete(requestId);
    }
  }

  private handleExit(code: number): void {
    if (this.disposed || this.exited) {
      return;
    }
    this.exited = true;
    this.exitCode = code;
    this.unsubscribeMessage();
    this.unsubscribeExit();
    const error = new AgentWorkerExitedError(code);
    for (const [requestId, stream] of [...this.pending]) {
      this.close(requestId, stream, error);
    }
  }
}

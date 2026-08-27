import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  ToolEventEnvelopeSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ToolExecutionEvent,
  type ToolRunRequest,
} from "@deepfield/contracts";
import {
  AgentProtocolError,
  AgentWorkerExitedError,
  AgentWorkerQueueOverflowError,
  AgentWorkerTransportReuseError,
  isChatTerminal,
  isHostRequest,
  isToolEventEnvelope,
  isToolTerminal,
  MAX_PENDING_CHAT_EVENTS,
  MAX_PENDING_TOOL_EVENTS,
  safeCorrelationId,
  ToolTransportTombstones,
  type PendingStream,
  type StreamEvent,
} from "./agent-worker-protocol.js";

export {
  AgentProtocolError,
  AgentWorkerExitedError,
  AgentWorkerQueueOverflowError,
  AgentWorkerTransportReuseError,
  MAX_PENDING_CHAT_EVENTS,
  MAX_PENDING_TOOL_EVENTS,
} from "./agent-worker-protocol.js";

export interface MessageEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}

export interface AgentWorkerClientOptions {
  /** Central host-request router: the single listener never competes. */
  hostHandler?: (message: unknown) => void;
}

export class AgentWorkerClient {
  private readonly pending = new Map<string, PendingStream>();
  private readonly tombstones = new ToolTransportTombstones();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly hostHandler: ((message: unknown) => void) | undefined;
  private disposed = false;
  private exited = false;
  private exitCode = 0;

  constructor(
    private readonly endpoint: MessageEndpoint,
    options: AgentWorkerClientOptions = {},
  ) {
    this.hostHandler = options.hostHandler;
    this.unsubscribeMessage = endpoint.onMessage((value) => this.handleMessage(value));
    this.unsubscribeExit = endpoint.onExit((code) => this.handleExit(code));
  }

  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    return this.sendStream<AgentWorkerEvent>({
      kind: "chat",
      id: request.requestId,
      request,
    });
  }

  sendTool(request: ToolRunRequest): AsyncIterable<ToolExecutionEvent> {
    // The transport requestId is the per-call generation: it is never reused,
    // so a late envelope from an old generation can never be mistaken for the
    // new stream, even when the executionId is reused.
    if (this.tombstones.has(request.requestId)) {
      throw new AgentWorkerTransportReuseError();
    }
    return this.sendStream<ToolExecutionEvent>({
      kind: "tool",
      id: request.requestId,
      executionId: request.executionId,
      traceId: request.traceId,
      request,
    });
  }

  private sendStream<T extends StreamEvent>(spec: {
    kind: "chat" | "tool";
    id: string;
    executionId?: string;
    traceId?: string;
    request: unknown;
  }): AsyncIterable<T> {
    if (this.disposed) {
      throw new Error("agent worker client is disposed");
    }
    if (this.exited) {
      throw new AgentWorkerExitedError(this.exitCode);
    }
    if (this.pending.has(spec.id)) {
      throw new Error(`duplicate request id: ${spec.id}`);
    }
    const stream: PendingStream = {
      kind: spec.kind,
      id: spec.id,
      ...(spec.executionId !== undefined ? { executionId: spec.executionId } : {}),
      ...(spec.traceId !== undefined ? { traceId: spec.traceId } : {}),
      queue: [],
      waiters: [],
      error: undefined,
      terminalSeen: false,
    };
    this.pending.set(spec.id, stream);
    try {
      this.endpoint.postMessage(spec.request);
    } catch (error) {
      this.pending.delete(spec.id);
      // The message may or may not have been delivered before the transport
      // threw. Safe semantics: treat a tool transport id as possibly-sent and
      // tombstone it so a late envelope can never be mistaken for a newer
      // stream (chat ids stay reusable, preserving P1 semantics).
      if (spec.kind === "tool") {
        this.tombstones.record(spec.id);
      }
      throw error;
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(stream) as Promise<IteratorResult<T>>,
        return: () => {
          this.cleanup(spec.id, stream);
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
        },
        throw: () => {
          this.cleanup(spec.id, stream);
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
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
    for (const [id, stream] of [...this.pending]) {
      this.close(id, stream, error);
    }
  }

  private handleMessage(value: unknown): void {
    if (this.disposed) {
      return;
    }
    if (isHostRequest(value)) {
      this.hostHandler?.(value);
      return;
    }
    if (Value.Check(AgentWorkerEventSchema, value)) {
      this.routeChat(value);
      return;
    }
    if (isToolEventEnvelope(value) && Value.Check(ToolEventEnvelopeSchema, value)) {
      this.routeToolEnvelope(value);
      return;
    }
    const id = safeCorrelationId(value);
    if (id !== undefined) {
      const stream = this.pending.get(id);
      if (stream) {
        this.close(id, stream, new AgentProtocolError());
      }
    }
  }

  private routeChat(event: AgentWorkerEvent): void {
    const stream = this.pending.get(event.requestId);
    if (!stream) {
      return;
    }
    if (stream.kind !== "chat") {
      this.close(stream.id, stream, new AgentProtocolError());
      return;
    }
    this.push(stream.id, stream, event);
  }
  private routeToolEnvelope(envelope: { requestId: string; event: ToolExecutionEvent }): void {
    const stream = this.pending.get(envelope.requestId);
    if (!stream) {
      return; // late envelope from an old generation or a foreign call: dropped
    }
    if (stream.kind !== "tool" ||
      stream.executionId !== envelope.event.executionId ||
      stream.traceId !== envelope.event.traceId
    ) {
      this.close(stream.id, stream, new AgentProtocolError());
      return;
    }
    this.push(stream.id, stream, envelope.event);
  }

  private push(id: string, stream: PendingStream, event: StreamEvent): void {
    if (stream.error || stream.terminalSeen) {
      return;
    }
    const terminal =
      stream.kind === "chat" ? isChatTerminal(event) : isToolTerminal(event);
    const waiter = stream.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      if (terminal) {
        stream.terminalSeen = true;
        this.cleanup(id, stream);
        for (const pendingWaiter of stream.waiters.splice(0)) {
          pendingWaiter.resolve({ value: undefined, done: true });
        }
      }
      return;
    }
    const max = stream.kind === "chat" ? MAX_PENDING_CHAT_EVENTS : MAX_PENDING_TOOL_EVENTS;
    if (stream.queue.length >= max) {
      this.close(id, stream, new AgentWorkerQueueOverflowError());
      return;
    }
    stream.queue.push(event);
    if (terminal) {
      stream.terminalSeen = true;
      this.cleanup(id, stream);
    }
  }

  private next(stream: PendingStream): Promise<IteratorResult<StreamEvent>> {
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

  private close(id: string, stream: PendingStream, error: Error): void {
    stream.error = error;
    stream.queue = [];
    for (const waiter of stream.waiters.splice(0)) {
      waiter.reject(error);
    }
    this.pending.delete(id);
    // Protocol errors and queue overflows terminate a tool stream just like a
    // terminal event: the transport id must be tombstoned so a late envelope
    // from this generation cannot poison a reused id.
    this.recordToolTombstoneFor(stream);
  }

  private recordToolTombstoneFor(stream: PendingStream): void {
    if (stream.kind === "tool") {
      this.tombstones.record(stream.id);
    }
  }

  private cleanup(id: string, stream: PendingStream): void {
    if (this.pending.get(id) === stream) {
      this.pending.delete(id);
    }
    // Bounded tombstone for TOOL transport ids only (chat request ids remain
    // reusable, preserving P1 semantics) so a tool transport id cannot be
    // reused in a window where a late reply would be indistinguishable.
    this.recordToolTombstoneFor(stream);
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
    for (const [id, stream] of [...this.pending]) {
      this.close(id, stream, error);
    }
  }
}

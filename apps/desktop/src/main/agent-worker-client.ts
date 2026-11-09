import { Value } from "typebox/value";
import { parseTraceEvent, parseTraceHealth, parseTraceContent, type TraceContentMode, type TraceHealth, type TraceContext, type TraceEvent } from "@deepfield/base/trace";
import { traceContentRequestSecrets, traceContentCredentialSafe, type TraceContentHost } from "../shared/trace-content.js";
import { currentTrace, type TraceScope } from "@deepfield/base/trace/runtime";
import { parseAgentCoordinatorSnapshot } from '@deepfield/base/agent/collaboration';
import type { ChatCollaborationState } from '@deepfield/contracts';
import { AgentWorkerEventSchema, ToolEventEnvelopeSchema, type AgentWorkerEvent, type AgentWorkerRequest, type ToolExecutionEvent, type ToolRunRequest } from "@deepfield/contracts";
import { CapabilityWorkerEventSchema, CapabilityActivationReplySchema, type CapabilityWorkerRequest, type CapabilityWorkerEvent } from "@deepfield/capability-sdk";
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
  MAX_PENDING_RESEARCH_EVENTS,
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
  MAX_PENDING_RESEARCH_EVENTS,
  MAX_PENDING_TOOL_EVENTS,
} from "./agent-worker-protocol.js";

export interface MessageEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}

export interface AgentWorkerClientOptions {
  traceContent?: TraceContentHost;
  trace?: (event: TraceEvent) => unknown;
  traceHealth?: (health: TraceHealth) => unknown;
  onTraceRejected?: () => void;
  /** Central host-request router: the single listener never competes. */
  hostHandler?: (message: unknown) => void;
  onUnavailable?: () => void;
}

export class AgentWorkerClient {
  private readonly contentOwners = new Map<string, { rootTraceId: string; parentSpanId: string; mode: TraceContentMode; expires: number; secrets: readonly string[] }>();
  private contentDeliveryPending = false;
  private readonly contentExpiry: ReturnType<typeof setInterval>;
  private readonly traceOwners = new Map<string, TraceContext & { conversationId?: string; parentRequestId?: string; taskId?: string }>();
  private readonly pending = new Map<string, PendingStream>();
  private readonly tombstones = new ToolTransportTombstones();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly hostHandler: ((message: unknown) => void) | undefined;
  private disposed = false;
  private exited = false;
  private exitCode = 0;
  private readonly activations = new Map<string, { capabilityId: string; finish(ok: boolean): void }>();
  private readonly onUnavailable: (() => void) | undefined;
  private readonly unavailableListeners = new Set<() => void>();
  private readonly activated = new Map<string, string>();

  constructor(
    private readonly endpoint: MessageEndpoint,
    private readonly options: AgentWorkerClientOptions = {},
  ) {
    this.contentExpiry = setInterval(() => { for (const [id, owner] of this.contentOwners) if (owner.expires <= Date.now()) this.contentOwners.delete(id); }, 30_000);
    this.contentExpiry.unref();
    this.hostHandler = options.hostHandler;
    this.onUnavailable = options.onUnavailable;
    this.unsubscribeMessage = endpoint.onMessage((value) => this.handleMessage(value));
    this.unsubscribeExit = endpoint.onExit((code) => this.handleExit(code));
  }

  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    if (request.trace && !this.pending.has(request.requestId)) {
      this.traceOwners.set(request.requestId, { ...request.trace, conversationId: request.context.conversationId });
      // Retain late telemetry after terminal delivery, with bounded memory.
      if (this.traceOwners.size > 2000) this.traceOwners.delete(this.traceOwners.keys().next().value!);
    }
    return this.sendStream<AgentWorkerEvent>({
      kind: "chat",
      id: request.requestId,
      request,
    });
  }

  /** Called only after the host has validated and durably saved this checkpoint. */
  registerCollaborationTrace(requestId: string, state: ChatCollaborationState): void {
    const owner = this.traceOwners.get(requestId);
    if (!owner || this.pending.get(requestId)?.kind !== 'chat' || owner.parentRequestId) return;
    try {
      const snapshot = parseAgentCoordinatorSnapshot(JSON.parse(state.snapshot));
      if (snapshot.owner.kind !== 'chat' || snapshot.owner.id !== owner.conversationId) return;
      const runs = snapshot.tasks.flatMap(task => task.runs.filter(run => ['queued', 'running', 'cancelling'].includes(run.status)).map(run => ({ taskId: task.taskId, runId: run.runId })));
      if (runs.some(run => { const existing = this.traceOwners.get(run.runId); return existing && (existing.parentRequestId !== requestId || existing.rootTraceId !== owner.rootTraceId || existing.taskId !== run.taskId); })) return;
      for (const run of runs) this.traceOwners.set(run.runId, { ...owner, parentRequestId: requestId, taskId: run.taskId });
      while (this.traceOwners.size > 2000) this.traceOwners.delete(this.traceOwners.keys().next().value!);
    } catch { /* Invalid optional telemetry never changes checkpoint delivery. */ }
  }

  traceForMemory(requestId: string, toolCallId: string, scope: TraceScope | undefined): TraceScope | undefined {
    if (!scope) return undefined;
    const owner = this.traceOwners.get(requestId), source = this.traceOwners.get(scope.requestId);
    if (!owner || !source || this.pending.get(requestId)?.kind !== 'chat' || scope.rootTraceId !== owner.rootTraceId || source.rootTraceId !== owner.rootTraceId || scope.spanId === owner.spanId) return undefined;
    if (scope.requestId !== requestId && (source.parentRequestId !== requestId || !toolCallId.startsWith(`${scope.requestId}:`) || toolCallId.length <= scope.requestId.length + 1)) return undefined;
    return { rootTraceId: scope.rootTraceId, spanId: scope.spanId, requestId: scope.requestId };
  }

  activateCapability(capabilityId: string, entry: string, requestId: string, timeoutMs = 10_000): Promise<void> {
    if (this.disposed || this.exited || this.activations.has(requestId) || this.pending.has(requestId) || this.tombstones.has(requestId)) return Promise.reject(new AgentProtocolError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean) => {
        if (!this.activations.delete(requestId)) return;
        clearTimeout(timer); this.tombstones.record(requestId);
        if (ok) { this.activated.set(capabilityId, requestId); resolve(); }
        else {
          if (!this.disposed && !this.exited) { try { this.endpoint.postMessage({ kind: "capability.deactivate", capabilityId, requestId }); } catch { /* dead transport */ } }
          reject(new AgentProtocolError());
        }
      };
      this.activations.set(requestId, { capabilityId, finish });
      try { this.endpoint.postMessage({ kind: "capability.activate", capabilityId, entry, requestId }); }
      catch { finish(false); }
    });
  }

  subscribeUnavailable(listener: () => void): () => void {
    if (this.disposed || this.exited) { listener(); return () => {}; }
    this.unavailableListeners.add(listener);
    return () => { this.unavailableListeners.delete(listener); };
  }
  deactivateCapability(capabilityId: string): void {
    const requestId = this.activated.get(capabilityId);
    this.activated.delete(capabilityId);
    if (requestId !== undefined && !this.disposed && !this.exited) this.endpoint.postMessage({ kind: "capability.deactivate", capabilityId, requestId });
  }
  private notifyUnavailable(): void {
    this.onUnavailable?.();
    for (const listener of this.unavailableListeners) { try { listener(); } catch { /* isolate owners */ } }
    this.unavailableListeners.clear();
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

  sendCapability(request: CapabilityWorkerRequest, validateCapabilityEvent?: (event: CapabilityWorkerEvent) => boolean | "ignore"): AsyncIterable<CapabilityWorkerEvent> {
    if (this.tombstones.has(request.requestId)) throw new AgentWorkerTransportReuseError();
    const parent = currentTrace();
    if (parent) request = { ...request, trace: { rootTraceId: parent.rootTraceId, spanId: parent.spanId } };
    if (request.trace && !this.pending.has(request.requestId)) {
      this.traceOwners.set(request.requestId, request.trace);
      if (this.traceOwners.size > 2000) this.traceOwners.delete(this.traceOwners.keys().next().value!);
    }
    return this.sendStream<CapabilityWorkerEvent>({ kind: "capability", id: request.requestId, capabilityId: request.capabilityId, operation: request.operation, request, ...(validateCapabilityEvent ? { validateCapabilityEvent } : {}) });
  }

  cancelCapability(requestId: string, capabilityId: string, operation: string): void {
    if (this.disposed) throw new Error("agent worker client is disposed");
    if (this.exited) throw new AgentWorkerExitedError(this.exitCode);
    this.endpoint.postMessage({ requestId, kind: "capability.cancel", capabilityId, operation });
  }

  cancel(requestId: string, taskId?: string): void {
    if (this.disposed || this.exited) throw new Error("agent worker unavailable");
    if (!this.pending.has(requestId)) return;
    this.endpoint.postMessage({ requestId, kind: "chat.cancel", ...(taskId ? { taskId } : {}) });
  }

  private sendStream<T extends StreamEvent>(spec: {
    kind: "chat" | "capability" | "tool";
    capabilityId?: string;
    operation?: string;
    validateCapabilityEvent?: (event: CapabilityWorkerEvent) => boolean | "ignore";
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
    if (this.pending.has(spec.id) || this.activations.has(spec.id)) {
      throw new Error(`duplicate request id: ${spec.id}`);
    }
    const stream: PendingStream = {
      kind: spec.kind,
      id: spec.id,
      ...(spec.capabilityId === undefined ? {} : { capabilityId: spec.capabilityId }),
      ...(spec.operation === undefined ? {} : { operation: spec.operation }),
      ...(spec.validateCapabilityEvent ? { validateCapabilityEvent: spec.validateCapabilityEvent } : {}),
      ...(spec.executionId !== undefined ? { executionId: spec.executionId } : {}),
      ...(spec.traceId !== undefined ? { traceId: spec.traceId } : {}),
      queue: [],
      waiters: [],
      error: undefined,
      terminalSeen: false,
    };
    this.pending.set(spec.id, stream);
    try {
      let outbound = spec.request;
      const request = spec.request as { trace?: TraceContext; requestId?: string };
      let mode: TraceContentMode | undefined;
      try { mode = this.options.traceContent?.modeFor(spec.id); } catch { /* Optional policy lookup cannot fail dispatch. */ }
      if (mode && request.trace && request.requestId === spec.id) {
        for (const [id, owner] of this.contentOwners) if (owner.expires <= Date.now()) this.contentOwners.delete(id);
        if (!this.contentOwners.has(spec.id) && this.contentOwners.size < 1000) {
          this.contentOwners.set(spec.id, { rootTraceId: request.trace.rootTraceId, parentSpanId: request.trace.spanId, mode, expires: Date.now() + 3600_000, secrets: traceContentRequestSecrets(spec.request) });
          outbound = { kind: "trace.content.run", mode, request: spec.request };
        }
      }
      this.endpoint.postMessage(outbound);
    } catch (error) {
      this.pending.delete(spec.id);
      // The message may or may not have been delivered before the transport
      // threw. Safe semantics: treat a tool transport id as possibly-sent and
      // tombstone it so a late envelope can never be mistaken for a newer
      // stream (chat ids stay reusable, preserving P1 semantics).
      if (spec.kind !== "chat") {
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
    clearInterval(this.contentExpiry);
    this.contentOwners.clear();
    this.traceOwners.clear();
    for (const activation of [...this.activations.values()]) activation.finish(false);
    this.notifyUnavailable();
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
    if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "trace.content") {
      const message = value as { deliveryId?: unknown; serialized?: unknown };
      const deliveryId = typeof message.deliveryId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(message.deliveryId) ? message.deliveryId : undefined;
      if (!deliveryId) return;
      if (this.contentDeliveryPending) { try { this.endpoint.postMessage({ kind: "trace.content.ack", deliveryId, accepted: false }); } catch {} return; }
      this.contentDeliveryPending = true;
      void (async () => {
        let accepted = false;
        try {
          if (typeof message.serialized !== "string") throw new Error("invalid_record");
          const record = parseTraceContent(message.serialized);
          const owner = this.contentOwners.get(record.requestId);
          if (!owner || owner.expires <= Date.now() || owner.rootTraceId !== record.rootTraceId || owner.parentSpanId === record.spanId || owner.mode !== record.captureMode) throw new Error("unauthorized_record");
          if (!traceContentCredentialSafe(record, owner.secrets)) throw new Error("unsafe_record");
          accepted = (await this.options.traceContent?.record(message.serialized)) !== false;
        } catch { /* Reject content without changing the business stream. */ }
        this.contentDeliveryPending = false;
        try { this.endpoint.postMessage({ kind: "trace.content.ack", deliveryId, accepted }); } catch { /* Dead optional transport. */ }
      })();
      return;
    }
    if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "trace.health") {
      try { void Promise.resolve(this.options.traceHealth?.(parseTraceHealth((value as { health?: unknown }).health))).catch(() => undefined); } catch { /* Optional health only. */ }
      return;
    }
    if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "trace.event") {
      try {
        const event = parseTraceEvent((value as { event?: unknown }).event);
        const owner = this.traceOwners.get(event.requestId);
        const childIdentityValid = !owner?.parentRequestId || !("kind" in event && event.kind === 'task') || (event.taskId === owner.taskId && event.runId === event.requestId);
        if (owner?.rootTraceId === event.rootTraceId && childIdentityValid && event.spanId !== owner.spanId && !("kind" in event && event.kind === "request") && !event.links?.some(link => link.rootTraceId !== owner.rootTraceId)) {
          void Promise.resolve(this.options.trace?.(event)).catch(() => undefined);
        }
        else this.options.onTraceRejected?.();
      } catch { try { this.options.onTraceRejected?.(); } catch { /* Optional telemetry. */ } }
      return;
    }
    if (isHostRequest(value)) {
      this.hostHandler?.(value);
      return;
    }
    if (Value.Check(CapabilityActivationReplySchema, value)) {
      const activation = this.activations.get(value.requestId);
      activation?.finish(activation.capabilityId === value.capabilityId && value.ok);
      return;
    }
    if (Value.Check(CapabilityWorkerEventSchema, value)) {
      const stream = this.pending.get(value.requestId);
      if (!stream) return;
      if (stream.kind !== "capability" || stream.capabilityId !== value.capabilityId || stream.operation !== value.operation) this.close(stream.id, stream, new AgentProtocolError());
      else {
        let valid: boolean | "ignore" = true;
        try { valid = stream.validateCapabilityEvent?.(value) ?? true; } catch { valid = false; }
        if (valid === false) this.close(stream.id, stream, new AgentProtocolError());
        else if (valid !== "ignore") this.push(stream.id, stream, value);
      }
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
    const terminal = stream.kind === "chat"
      ? isChatTerminal(event)
      : isToolTerminal(event);
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
    const max = stream.kind === "chat"
      ? MAX_PENDING_CHAT_EVENTS
      : stream.kind === "capability"
        ? MAX_PENDING_RESEARCH_EVENTS
        : MAX_PENDING_TOOL_EVENTS;
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
    this.contentOwners.delete(id);
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
    if (stream.kind !== "chat") {
      this.tombstones.record(stream.id);
    }
  }

  private cleanup(id: string, stream: PendingStream): void {
    const contentOwner = this.contentOwners.get(id);
    if (contentOwner) contentOwner.expires = Math.min(contentOwner.expires, Date.now() + 30_000);
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
    clearInterval(this.contentExpiry);
    this.contentOwners.clear();
    for (const activation of [...this.activations.values()]) activation.finish(false);
    this.notifyUnavailable();
    this.exitCode = code;
    this.unsubscribeMessage();
    this.unsubscribeExit();
    const error = new AgentWorkerExitedError(code);
    for (const [id, stream] of [...this.pending]) {
      this.close(id, stream, error);
    }
  }
}

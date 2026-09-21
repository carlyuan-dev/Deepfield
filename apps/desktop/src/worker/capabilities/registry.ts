import { Value } from "typebox/value";
import type { TSchema, Static } from "typebox";
import { createResourceScope, CapabilityWorkerRequestSchema, CapabilityWorkerCancelSchema, CapabilityActivationRequestSchema, CapabilityDeactivationSchema, type CapabilityWorkerRegistrar, type CapabilityWorkerRequest, type CapabilityWorkerEvent, type CapabilityActivationRequest, type Cleanup } from "@deepfield/capability-sdk";

type Handler = (request: CapabilityWorkerRequest, emit: (payload: unknown, terminal?: "completed" | "failed" | "cancelled") => void, signal: AbortSignal) => Promise<void>;
export type CapabilityWorkerLoader = (request: CapabilityActivationRequest, registrar: CapabilityWorkerRegistrar) => Promise<void>;
/** The loader receives only Main's trusted snapshot entries, never renderer payload paths. */
export class WorkerCapabilityRegistry {
  private readonly packages = new Map<string, { handlers: Map<string, Handler>; dispose(): Promise<void>; ready: boolean }>();
  private readonly active = new Map<string, { request: CapabilityWorkerRequest; controller: AbortController; finish(type: CapabilityWorkerEvent["type"], payload: unknown): void }>();
  private disposed = false;
  private readonly activations = new Map<string, { capabilityId: string; dispose(): Promise<void> }>();
  constructor(private readonly post: (event: unknown) => void, private readonly loader?: CapabilityWorkerLoader) {}
  begin(capabilityId: string): CapabilityWorkerRegistrar & { ready(): void; dispose(): Promise<void> } {
    if (this.disposed || this.packages.has(capabilityId)) throw new Error("invalid_activation");
    const scope = createResourceScope();
    let disposed = false;
    const entry = { handlers: new Map<string, Handler>(), ready: false, dispose: async () => {
      disposed = true;
      entry.ready = false;
      if (this.packages.get(capabilityId) === entry) this.packages.delete(capabilityId);
      for (const execution of [...this.active.values()]) if (execution.request.capabilityId === capabilityId) {
        execution.finish("failed", { code: "capability_unavailable" }); execution.controller.abort();
      }
      await scope.dispose();
    } };
    this.packages.set(capabilityId, entry);
    return {
      defer: cleanup => {
        if (disposed) { void Promise.resolve().then(cleanup).catch(() => {}); throw new Error("activation_disposed"); }
        scope.defer(cleanup);
      },
      register<I extends TSchema, O extends TSchema>(operation: string, input: I, output: O, handler: (input: Static<I>, emit: (payload: Static<O>, terminal?: "completed" | "failed" | "cancelled") => void, signal: AbortSignal) => Promise<void>): Cleanup {
        if (disposed || entry.handlers.has(operation)) throw new Error("duplicate_operation");
        entry.handlers.set(operation, async (request, emit, signal) => {
          if (!Value.Check(input, request.input)) throw new Error("invalid_input");
          await handler(request.input, (payload, terminal) => {
            if (!Value.Check(output, payload)) throw new Error("invalid_output");
            emit(payload, terminal);
          }, signal);
        });
        const cleanup = () => { entry.handlers.delete(operation); };
        scope.defer(cleanup);
        return cleanup;
      },
      ready: () => { if (this.disposed || this.packages.get(capabilityId) !== entry) throw new Error("invalid_activation"); entry.ready = true; },
      dispose: entry.dispose,
    };
  }
  has(requestId: string): boolean { return this.active.has(requestId); }
  rejectDuplicate(requestId: string): void {
    const execution = this.active.get(requestId);
    if (execution) { execution.finish("failed", { code: "duplicate_request" }); execution.controller.abort(); }
  }
  activeCount(): number { return this.active.size; }
  handle(value: unknown): boolean {
    if (this.disposed) return false;
    if (Value.Check(CapabilityActivationRequestSchema, value)) {
      void this.activate(value); return true;
    }
    if (Value.Check(CapabilityDeactivationSchema, value)) {
      const activation = this.activations.get(value.requestId);
      if (activation?.capabilityId === value.capabilityId) {
        this.activations.delete(value.requestId);
        void activation.dispose();
      }
      return true;
    }
    if (Value.Check(CapabilityWorkerCancelSchema, value)) {
      const execution = this.active.get(value.requestId);
      if (execution?.request.capabilityId === value.capabilityId && execution.request.operation === value.operation) {
        execution.finish("cancelled", null); execution.controller.abort();
      }
      return true;
    }
    if (!Value.Check(CapabilityWorkerRequestSchema, value)) return false;
    const existing = this.active.get(value.requestId);
    if (existing) { existing.finish("failed", { code: "duplicate_request" }); existing.controller.abort(); return true; }
    const entry = this.packages.get(value.capabilityId);
    const handler = entry?.ready ? entry.handlers.get(value.operation) : undefined;
    const controller = new AbortController();
    let settled = false;
    const finish = (type: CapabilityWorkerEvent["type"], payload: unknown) => {
      if (settled || this.disposed) return;
      if (type !== "progress") { settled = true; this.active.delete(value.requestId); }
      this.post({ kind: "capability.event", capabilityId: value.capabilityId, operation: value.operation, requestId: value.requestId, type, payload } satisfies CapabilityWorkerEvent);
    };
    this.active.set(value.requestId, { request: value, controller, finish });
    if (!handler) { finish("failed", { code: "capability_unavailable" }); return true; }
    void Promise.resolve().then(() => handler(value, (payload, terminal) => finish(terminal ?? "progress", payload), controller.signal))
      .then(() => finish("failed", { code: "missing_terminal" }))
      .catch(() => { finish("failed", { code: "capability_failed" }); controller.abort(); });
    return true;
  }
  private async activate(request: CapabilityActivationRequest): Promise<void> {
    let activation: ReturnType<WorkerCapabilityRegistry["begin"]> | undefined;
    let ok = false;
    try {
      if (!this.loader) throw new Error("loader_unavailable");
      activation = this.begin(request.capabilityId);
      this.activations.set(request.requestId, { capabilityId: request.capabilityId, dispose: activation.dispose });
      await this.loader(request, activation);
      activation.ready();
      ok = true;
    } catch { await activation?.dispose(); this.activations.delete(request.requestId); }
    if (!this.disposed) this.post({ kind: "capability.activated", requestId: request.requestId, capabilityId: request.capabilityId, ok });
  }
  /** Shutdown interruption must never emit a user-cancel terminal that deletes a report. */
  abortAll(): void { this.disposed = true; for (const execution of this.active.values()) execution.controller.abort(); this.active.clear(); }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.abortAll(); this.active.clear();
    await Promise.all([...this.packages.values()].map(entry => entry.dispose()));
    this.activations.clear();
  }
}

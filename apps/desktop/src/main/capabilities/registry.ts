import { Value } from "typebox/value";
import type { TSchema, Static } from "typebox";
import { CapabilityCallSchema, CapabilityUnavailableError, createResourceScope, type CapabilityCall, type CapabilityEvent, type CapabilityRegistrar, type Cleanup } from "@deepfield/capability-sdk";
import { AppError } from "@deepfield/contracts";

export interface CapabilityActivation extends CapabilityRegistrar {
  ready(): Promise<void>;
  dispose(): Promise<void>;
}
interface Entry { ready: boolean; operations: Map<string, (input: unknown) => Promise<unknown>>; dispose(): Promise<void> }

export class CapabilityRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: CapabilityEvent) => void>();
  private readonly disposals = new Set<Promise<void>>();
  begin(capabilityId: string): CapabilityActivation {
    if (this.entries.has(capabilityId)) throw new Error("duplicate_capability");
    const scope = createResourceScope();
    const topics = new Map<string, TSchema>();
    const starts: Array<() => void | Promise<void>> = [];
    let disposed = false;
    let starting: Promise<void> | undefined;
    const entry: Entry = { ready: false, operations: new Map(), dispose: () => {
      disposed = true;
      entry.ready = false;
      if (this.entries.get(capabilityId) === entry) this.entries.delete(capabilityId);
      const pending = scope.dispose();
      this.disposals.add(pending);
      void pending.then(() => this.disposals.delete(pending));
      return pending;
    } };
    this.entries.set(capabilityId, entry);
    const defer = (cleanup: Cleanup) => {
      if (disposed) { void Promise.resolve().then(cleanup).catch(() => {}); throw new CapabilityUnavailableError(); }
      scope.defer(cleanup);
    };
    return {
      defer,
      register<I extends TSchema, O extends TSchema>(operation: string, input: I, output: O, handler: (value: Static<I>) => Static<O> | Promise<Static<O>>) {
        if (disposed || entry.operations.has(operation)) throw new Error("invalid_registration");
        const call = async (value: unknown) => {
          if (!Value.Check(input, value)) throw new AppError("INPUT.INVALID");
          const result = await handler(value);
          if (!Value.Check(output, result)) throw new AppError("INTERNAL.UNKNOWN");
          return result;
        };
        entry.operations.set(operation, call);
        const cleanup = () => { if (entry.operations.get(operation) === call) entry.operations.delete(operation); };
        defer(cleanup);
        return cleanup;
      },
      registerTopic(topic, schema) {
        if (disposed || topics.has(topic)) throw new Error("invalid_registration");
        topics.set(topic, schema);
        const cleanup = () => { topics.delete(topic); };
        defer(cleanup);
        return cleanup;
      },
      emit: (topic, payload) => {
        if (disposed || !entry.ready) return;
        const schema = topics.get(topic);
        if (!schema || !Value.Check(schema, payload)) throw new AppError("INPUT.INVALID");
        for (const listener of this.listeners) { try { listener({ capabilityId, topic, payload }); } catch { /* isolated subscriber */ } }
      },
      onReady(start) { if (disposed || starting) throw new Error("invalid_activation"); starts.push(start); },
      ready() {
        starting ??= (async () => {
          try {
            if (disposed) throw new CapabilityUnavailableError();
            for (const start of starts) await start();
            if (disposed) throw new CapabilityUnavailableError();
            entry.ready = true;
          } catch (error) { await entry.dispose(); throw error; }
        })();
        return starting;
      },
      dispose: entry.dispose,
    };
  }
  async call(call: CapabilityCall): Promise<unknown> {
    if (!Value.Check(CapabilityCallSchema, call)) throw new AppError("INPUT.INVALID");
    const entry = this.entries.get(call.capabilityId);
    const handler = entry?.operations.get(call.operation);
    if (!entry?.ready || !handler) throw new AppError("capability_unavailable");
    return handler(call.input);
  }
  readyIds(): string[] { return [...this.entries].filter(([, entry]) => entry.ready).map(([id]) => id); }
  subscribe(listener: (event: CapabilityEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async dispose(): Promise<void> { for (const entry of [...this.entries.values()]) void entry.dispose(); await Promise.all(this.disposals); this.listeners.clear(); }
}

/** Shared activation transaction: publish only after both entrypoints and ready hooks succeed. */
export async function activateRegisteredCapability(options: {
  registry: CapabilityRegistry;
  capabilityId: string;
  activateMain(registrar: CapabilityRegistrar): void | Promise<void>;
  activateWorker(): Promise<void>;
  deactivateWorker?(): void | Promise<void>;
  onWorkerUnavailable(listener: () => void): () => void;
}): Promise<CapabilityActivation> {
  const activation = options.registry.begin(options.capabilityId);
  activation.defer(options.onWorkerUnavailable(() => { void activation.dispose(); }));
  try {
    if (options.deactivateWorker) activation.defer(options.deactivateWorker);
    await options.activateMain(activation);
    await options.activateWorker();
    await activation.ready();
    return activation;
  } catch (error) { await activation.dispose(); throw error; }
}

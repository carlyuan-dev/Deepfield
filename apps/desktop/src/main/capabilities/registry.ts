import { Value } from "typebox/value";
import type { TaskProvider, ArtifactProvider, CapabilityFormDefinition, CapabilityFormProvider } from "@deepfield/capability-sdk";
import type { TSchema, Static } from "typebox";
import { CapabilityCallSchema, CapabilityUnavailableError, canonicalActionJson, createResourceScope, type ActionDefinition, type CapabilityCall, type CapabilityEvent, type CapabilityRegistrar, type Cleanup } from "@deepfield/capability-sdk";
import { AppError } from "@deepfield/contracts";
import { freezeActionData, type PublicActionEntry } from "./action-catalog.js";
import { ViewRefSchema, DraftRefSchema, type ViewProvider, type ViewResolution, type CapabilityUiOpenTarget, type CapabilityManifestV2 } from "@deepfield/capability-sdk";

export interface CapabilityActivation extends CapabilityRegistrar {
  ready(): Promise<void>;
  dispose(): Promise<void>;
}
interface Entry { ready: boolean; operations: Map<string, (input: unknown) => Promise<unknown>>; actions: Map<string, ActionDefinition>; taskProvider?: TaskProvider; artifactProvider?: ArtifactProvider; viewProvider?: ViewProvider; formProvider?: CapabilityFormProvider; forms: readonly CapabilityFormDefinition[]; views: NonNullable<CapabilityManifestV2["views"]>; dispose(): Promise<void> }

export class CapabilityRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: CapabilityEvent) => void>();
  private readonly disposals = new Set<Promise<void>>();
  private readonly disposalListeners = new Set<(capabilityId: string) => void>();
  begin(capabilityId: string, publicActions: readonly PublicActionEntry[] = [], views: NonNullable<CapabilityManifestV2["views"]> = []): CapabilityActivation {
    if (this.entries.has(capabilityId)) throw new Error("duplicate_capability");
    const scope = createResourceScope();
    const topics = new Map<string, TSchema>();
    const starts: Array<() => void | Promise<void>> = [];
    let disposed = false;
    let starting: Promise<void> | undefined;
    let invalidActions = false;
    const expected = new Map(publicActions.map(action => [action.actionId, action.declaration]));
    const entry: Entry = { ready: false, operations: new Map(), actions: new Map(), forms: [], views: JSON.parse(JSON.stringify(views)), dispose: () => {
      if (!disposed) for (const listener of this.disposalListeners) { try { listener(capabilityId); } catch { /* isolated subscriber */ } }
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
      registerTaskProvider(provider) {
        if (disposed || starting || entry.taskProvider || typeof provider.get !== "function" || typeof provider.cancel !== "function" || !validPermissions(provider.permissions?.read) || !validPermissions(provider.permissions?.cancel) || (provider.findByInvocation !== undefined && typeof provider.findByInvocation !== "function") || (provider.subscribe !== undefined && typeof provider.subscribe !== "function")) throw new Error("invalid_task_registration");
        const stored: TaskProvider = Object.freeze({ permissions: Object.freeze({ read: Object.freeze([...provider.permissions.read]), cancel: Object.freeze([...provider.permissions.cancel]) }), get: provider.get.bind(provider), cancel: provider.cancel.bind(provider), ...(provider.findByInvocation ? { findByInvocation: provider.findByInvocation.bind(provider) } : {}), ...(provider.subscribe ? { subscribe: provider.subscribe.bind(provider) } : {}) });
        entry.taskProvider = stored;
        const cleanup = () => { if (entry.taskProvider === stored) delete entry.taskProvider; }; defer(cleanup); return cleanup;
      },
      registerArtifactProvider(provider) {
        if (disposed || starting || entry.artifactProvider || typeof provider.read !== "function" || !validPermissions(provider.permissions?.read)) throw new Error("invalid_artifact_registration");
        const stored: ArtifactProvider = Object.freeze({ permissions: Object.freeze({ read: Object.freeze([...provider.permissions.read]) }), read: provider.read.bind(provider) });
        entry.artifactProvider = stored;
        const cleanup = () => { if (entry.artifactProvider === stored) delete entry.artifactProvider; }; defer(cleanup); return cleanup;
      },
      registerViewProvider(provider) {
        if (disposed || starting || entry.viewProvider || !entry.views.length || typeof provider.resolve !== "function") throw new Error("invalid_view_registration");
        entry.viewProvider = provider;
        const cleanup = () => { if (entry.viewProvider === provider) delete entry.viewProvider; };
        defer(cleanup); return cleanup;
      },
      registerFormProvider(definitions, provider) {
        // A broken optional form declaration must not prevent the package's actions from activating.
        if (disposed || starting || entry.formProvider || !validFormProvider(provider) || !Array.isArray(definitions)) return () => {};
        const idCounts = new Map<string, number>();
        for (const definition of definitions) {
          if (definition && typeof definition === "object" && typeof definition.id === "string")
            idCounts.set(definition.id, (idCounts.get(definition.id) ?? 0) + 1);
        }
        const valid = definitions.filter(definition => {
          if (!validFormDefinition(definition) || idCounts.get(definition.id) !== 1
            || definition.actionIds.some(actionId => !expected.has(actionId))) return false;
          return true;
        });
        if (!valid.length) return () => {};
        const storedDefinitions = Object.freeze(valid.map(definition => Object.freeze({
          id: definition.id, description: definition.description,
          actionIds: Object.freeze([...definition.actionIds]),
        })));
        const storedProvider: CapabilityFormProvider = Object.freeze({
          prepare: provider.prepare.bind(provider), read: provider.read.bind(provider),
          update: provider.update.bind(provider), transition: provider.transition.bind(provider),
          validate: provider.validate.bind(provider), submission: provider.submission.bind(provider),
          release: provider.release.bind(provider),
          ...(typeof provider.afterAction === "function" ? { afterAction: provider.afterAction.bind(provider) } : {}),
        });
        entry.forms = storedDefinitions;
        entry.formProvider = storedProvider;
        const cleanup = () => { if (entry.formProvider === storedProvider) { entry.forms = []; delete entry.formProvider; } };
        defer(cleanup);
        return cleanup;
      },
      registerAction(action) {
        const declaration = expected.get(action.definition.id);
        const { handler, presentInput, presentOperation, presentTaskScope, ...definition } = action.definition;
        const metadata = { ...definition, documentation: { ...definition.documentation, digest: declaration?.documentation.digest }, contractDigest: declaration?.contractDigest };
        if (disposed || starting || entry.actions.has(action.definition.id) || !declaration || typeof handler !== "function"
          || (presentInput !== undefined && typeof presentInput !== "function")
          || (presentOperation !== undefined && typeof presentOperation !== "function")
          || (presentTaskScope !== undefined && typeof presentTaskScope !== "function")
          || canonicalActionJson(action.declaration) !== canonicalActionJson(declaration)
          || canonicalActionJson(metadata) !== canonicalActionJson(declaration)) {
          invalidActions = true;
          throw new Error("action_registration_mismatch");
        }
        // Keep the checked contract and handler independently of mutable package-owned definitions.
        const stored = freezeActionData({ ...JSON.parse(JSON.stringify(definition)), handler,
          ...(presentInput ? { presentInput } : {}), ...(presentOperation ? { presentOperation } : {}), ...(presentTaskScope ? { presentTaskScope } : {}) } as ActionDefinition);
        entry.actions.set(declaration.id, stored);
        const cleanup = () => { if (entry.actions.get(declaration.id) === stored) entry.actions.delete(declaration.id); };
        defer(cleanup);
        return cleanup;
      },
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
            if (invalidActions || expected.size !== entry.actions.size) throw new Error("action_registration_mismatch");
            for (const start of starts) await start();
            if (disposed) throw new CapabilityUnavailableError();
            if (invalidActions || expected.size !== entry.actions.size) throw new Error("action_registration_mismatch");
            entry.forms = Object.freeze(entry.forms.filter(form => form.actionIds.every(actionId => entry.actions.has(actionId))));
            if (!entry.forms.length) delete entry.formProvider;
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
  taskProvider(id: string): TaskProvider | undefined { const entry = this.entries.get(id); return entry?.ready ? entry.taskProvider : undefined; }
  artifactProvider(id: string): ArtifactProvider | undefined { const entry = this.entries.get(id); return entry?.ready ? entry.artifactProvider : undefined; }
  forms(id: string): readonly CapabilityFormDefinition[] { const entry = this.entries.get(id); return entry?.ready ? entry.forms : []; }
  formProvider(id: string): CapabilityFormProvider | undefined { const entry = this.entries.get(id); return entry?.ready ? entry.formProvider : undefined; }
  async resolveView(target: CapabilityUiOpenTarget): Promise<ViewResolution> {
    if (!Value.Check(ViewRefSchema, target) && !Value.Check(DraftRefSchema, target)) return { status: "not_found", message: "invalid_target" };
    const entry = this.entries.get(target.capabilityId);
    if (!entry?.ready) return { status: "not_found", message: "capability_unavailable" };
    if (!entry.viewProvider) return { status: "unsupported" };
    const validView = (view: unknown): boolean => {
      if (!Value.Check(ViewRefSchema, view) || view.capabilityId !== target.capabilityId) return false;
      const declaration = entry.views.find(item => item.id === view.viewId);
      return !!declaration && Value.Check(declaration.inputSchema as TSchema, view.input);
    };
    if ("viewId" in target && !validView(target)) return { status: "not_found", message: "invalid_view" };
    const result = await entry.viewProvider.resolve(target);
    if (!entry.ready || this.entries.get(target.capabilityId) !== entry) return { status: "not_found", message: "capability_unavailable" };
    if (result.status === "resolved") return validView(result.view) ? { status: "resolved", view: JSON.parse(JSON.stringify(result.view)) } : { status: "not_found", message: "invalid_view" };
    if (!["blocked", "unsupported", "not_found"].includes(result.status)) return { status: "unsupported" };
    return { status: result.status, ...(typeof result.message === "string" && result.message ? { message: result.message } : {}) };
  }
  publicAction(capabilityId: string, actionId: string): ActionDefinition | undefined {
    const entry = this.entries.get(capabilityId);
    return entry?.ready ? entry.actions.get(actionId) : undefined;
  }
  onDispose(listener: (capabilityId: string) => void): () => void { this.disposalListeners.add(listener); return () => { this.disposalListeners.delete(listener); }; }
  subscribe(listener: (event: CapabilityEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async dispose(): Promise<void> { for (const entry of [...this.entries.values()]) void entry.dispose(); await Promise.all(this.disposals); this.listeners.clear(); this.disposalListeners.clear(); }
}

function validPermissions(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0); }

function validFormDefinition(value: unknown): value is CapabilityFormDefinition {
  if (!value || typeof value !== "object") return false;
  const form = value as Partial<CapabilityFormDefinition>;
  return typeof form.id === "string" && form.id.trim().length > 0
    && typeof form.description === "string" && form.description.trim().length > 0
    && Array.isArray(form.actionIds) && form.actionIds.length > 0
    && form.actionIds.every(actionId => typeof actionId === "string" && actionId.trim().length > 0)
    && new Set(form.actionIds).size === form.actionIds.length;
}

function validFormProvider(value: unknown): value is CapabilityFormProvider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Partial<CapabilityFormProvider>;
  return ["prepare", "read", "update", "transition", "validate", "submission", "release"]
    .every(method => typeof provider[method as keyof CapabilityFormProvider] === "function");
}

/** Shared activation transaction: publish only after both entrypoints and ready hooks succeed. */
export async function activateRegisteredCapability(options: {
  registry: CapabilityRegistry;
  capabilityId: string;
  publicActions?: readonly PublicActionEntry[];
  views?: NonNullable<CapabilityManifestV2["views"]>;
  activateMain(registrar: CapabilityRegistrar): void | Promise<void>;
  activateWorker?(): Promise<void>;
  deactivateWorker?(): void | Promise<void>;
  onWorkerUnavailable?(listener: () => void): () => void;
}): Promise<CapabilityActivation> {
  const activation = options.registry.begin(options.capabilityId, options.publicActions, options.views);
  if (options.onWorkerUnavailable) activation.defer(options.onWorkerUnavailable(() => { void activation.dispose(); }));
  try {
    if (options.deactivateWorker) activation.defer(options.deactivateWorker);
    await options.activateMain(activation);
    await options.activateWorker?.();
    await activation.ready();
    return activation;
  } catch (error) { await activation.dispose(); throw error; }
}

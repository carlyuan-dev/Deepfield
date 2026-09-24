import { Value } from "typebox/value";
import { TaskRefSchema, TaskSnapshotSchema, ArtifactRefSchema, ReadSliceSchema, type TaskRef, type TaskSnapshot, type ArtifactRef, type ArtifactReadRequest, type ReadSlice } from "@deepfield/capability-sdk";
import type { InvocationRepository } from "@deepfield/persistence";
import { CapabilityRegistry } from "./registry.js";
import { bounded, checkAccess, GatewayError, safeGatewayError, taskCompletionTime } from "./gateway-policy.js";
import { safeOperationPresentation } from "./operation-presentation.js";
type Context = { permissions: readonly string[] };
export type ProviderResult<T> = { status: "completed"; data: T } | { status: "error"; error: ReturnType<typeof safeGatewayError> };
export class TaskArtifactGateway {
  constructor(private readonly registry: CapabilityRegistry, private readonly receipts?: InvocationRepository, private readonly now = Date.now) {}
  get(ref: TaskRef, context: Context) { return this.task(ref, context, "get"); }
  cancel(ref: TaskRef, context: Context) { return this.task(ref, context, "cancel"); }
  async findByInvocation(capabilityId: string, invocationId: string, context: Context): Promise<ProviderResult<TaskSnapshot | null>> {
    return this.run(async () => {
      const provider = this.registry.taskProvider(capabilityId);
      checkAccess(this.registry, capabilityId, provider?.permissions.read ?? [], context);
      if (!provider?.findByInvocation) throw new GatewayError("reconciliation_required");
      const snapshot = await provider.findByInvocation(invocationId);
      if (this.registry.taskProvider(capabilityId) !== provider) throw new GatewayError("capability_unavailable");
      return snapshot ? this.snapshot(snapshot, capabilityId) : null;
    });
  }
  async read(ref: ArtifactRef, request: ArtifactReadRequest, context: Context): Promise<ProviderResult<ReadSlice>> {
    return this.run(async () => {
      if (!Value.Check(ArtifactRefSchema, ref) || !request || Object.keys(request).some(key => !["cursor", "section"].includes(key)) || Object.values(request).some(value => typeof value !== "string" || !value.length)) throw new GatewayError("INPUT.INVALID");
      const provider = this.registry.artifactProvider(ref.capabilityId);
      checkAccess(this.registry, ref.capabilityId, provider?.permissions.read ?? [], context);
      if (!provider) throw new GatewayError("capability_unavailable");
      const slice = await provider.read(structuredClone(ref), structuredClone(request));
      if (this.registry.artifactProvider(ref.capabilityId) !== provider) throw new GatewayError("capability_unavailable");
      if (!Value.Check(ReadSliceSchema, slice)) throw new GatewayError("INTERNAL.UNKNOWN");
      if (slice.revision !== ref.revision) throw new GatewayError("revision_changed");
      return slice;
    });
  }
  private async task(ref: TaskRef, context: Context, operation: "get" | "cancel"): Promise<ProviderResult<TaskSnapshot>> {
    return this.run(async () => {
      if (!Value.Check(TaskRefSchema, ref)) throw new GatewayError("INPUT.INVALID");
      const provider = this.registry.taskProvider(ref.capabilityId);
      checkAccess(this.registry, ref.capabilityId, provider?.permissions[operation === "get" ? "read" : "cancel"] ?? [], context);
      if (!provider) throw new GatewayError("capability_unavailable");
      const result = await provider[operation](structuredClone(ref));
      if (this.registry.taskProvider(ref.capabilityId) !== provider) throw new GatewayError("capability_unavailable");
      return this.snapshot(result, ref.capabilityId, ref.taskId);
    });
  }
  private snapshot(value: TaskSnapshot, capabilityId: string, taskId?: string): TaskSnapshot {
    const { presentation: optionalPresentation, ...coreSnapshot } = value;
    if (!Value.Check(TaskSnapshotSchema, coreSnapshot) || value.taskRef.capabilityId !== capabilityId || (taskId !== undefined && value.taskRef.taskId !== taskId) || value.artifactRefs?.some(ref => ref.capabilityId !== capabilityId)) throw new GatewayError("INTERNAL.UNKNOWN");
    const presentation = safeOperationPresentation(optionalPresentation, capabilityId);
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(value.status);
    const completedAt = terminal ? taskCompletionTime(value.finishedAt, this.now()) : undefined;
    const coreResult = { ...coreSnapshot, ...(completedAt === undefined ? {} : { finishedAt: new Date(completedAt).toISOString() }), ...(value.error ? { error: safeGatewayError(value.error) } : {}) };
    bounded({ status: "completed", data: coreResult });
    let result: TaskSnapshot = coreResult;
    if (presentation) {
      try { result = bounded({ status: "completed", data: { ...coreResult, presentation } }).data; }
      catch (error) { if (!(error instanceof GatewayError) || error.code !== "response_too_large") throw error; }
    }
    if (completedAt !== undefined) this.receipts?.markTaskTerminal(capabilityId, value.taskRef.taskId, completedAt);
    return result;
  }
  private async run<T>(work: () => Promise<T>): Promise<ProviderResult<T>> {
    try { return bounded({ status: "completed", data: await work() }); }
    catch (error) { return { status: "error", error: safeGatewayError(error) }; }
  }
}

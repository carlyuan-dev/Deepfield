import type { TSchema } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import type { InvocationRepository, InvocationRecord } from "@deepfield/persistence";
import { Value } from "typebox/value";
import { AppError } from "@deepfield/contracts";
import { ActionCallSchema, ActionOutcomeSchema, canonicalActionJson, type ActionCall, type ActionInputPresentation, type ActionResult, type ActionResultMetadata } from "@deepfield/capability-sdk";
import { ActionCatalog, type PublicActionEntry } from "./action-catalog.js";
import { ActionConfirmations, type TrustedActionContext } from "./action-confirmations.js";
import type { CapabilityRegistry } from "./registry.js";
import { bounded, checkAccess, GatewayError, safeGatewayError, taskCompletionTime } from "./gateway-policy.js";
import { TaskArtifactGateway } from "./task-artifact-gateway.js";
import { boundedWithPresentation, safeOperationPresentation } from "./operation-presentation.js";

class InputValidationError extends AppError {
  readonly fieldErrors: Array<{ path: string; message: string }>;
  constructor(schema: TSchema, input: unknown) {
    super("INPUT.INVALID");
    this.fieldErrors = Value.Errors(schema, input).slice(0, 20).flatMap(error => {
      const paths = error.keyword === "required"
        ? error.params.requiredProperties.map(name => `${error.instancePath}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`)
        : [error.instancePath || "/"];
      return paths.map(path => ({ path, message: error.keyword }));
    });
  }
}
type GatewayResult = ActionResult<TSchema>;
type DescriptionResult = (ActionResultMetadata & { status: "described"; declaration: PublicActionEntry["declaration"]; documentation: string }) | Extract<GatewayResult, { status: "error" }>;

/** Enforce a JSON value before canonical copying; never silently drop undefined/functions or coerce NaN. */
function normalizeInput(input: unknown): unknown {
  const active = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
    if (typeof value !== "object" || active.has(value)) throw new AppError("INPUT.INVALID");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new AppError("INPUT.INVALID");
    active.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value)) visit(nested);
    active.delete(value);
  };
  visit(input);
  return JSON.parse(canonicalActionJson(input));
}

/** Reject incomplete or oversized copy rather than hiding an authorization target. */
function validatedPresentation(value: unknown): ActionInputPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("presentation_invalid");
  const candidate = value as { title?: unknown; fields?: unknown };
  const validText = (text: unknown, limit: number): text is string =>
    typeof text === "string" && text.trim().length > 0 && text.length <= limit;
  if (!validText(candidate.title, 120) || !Array.isArray(candidate.fields) || candidate.fields.length > 12) throw new GatewayError("presentation_invalid");
  const fields = candidate.fields.map((field: unknown) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) throw new GatewayError("presentation_invalid");
    const item = field as { label?: unknown; value?: unknown };
    if (!validText(item.label, 60) || !validText(item.value, 4000)) throw new GatewayError("presentation_invalid");
    return { label: item.label.trim(), value: item.value.trim() };
  });
  return { title: candidate.title.trim(), fields };
}

/** Called only from trusted main-process adapters; the call itself grants no authority. */
export class ActionGateway {
  constructor(private readonly registry: CapabilityRegistry, private readonly catalog: () => ActionCatalog, private readonly confirmations: ActionConfirmations, private readonly receipts?: InvocationRepository, private readonly now = Date.now) {}
  /** Read-only concrete proposal validation. Does not issue an invocation, ticket, or call a handler. */
  async preview(call: ActionCall, caller: Omit<TrustedActionContext, "invocationId">): Promise<ActionInputPresentation> {
    this.resolve(call);
    const action = this.registry.publicAction(call.capabilityId, call.actionId)!;
    checkAccess(this.registry, call.capabilityId, action.permissions, caller);
    const input = normalizeInput(call.input);
    if (!Value.Check(action.inputSchema, input)) throw new InputValidationError(action.inputSchema, input);
    if (!action.presentInput) throw new GatewayError("presentation_invalid");
    return validatedPresentation(await action.presentInput(input));
  }
  /** A missing retained receipt must never authorize replacing an uncertain dispatch. */
  requiresReconciliation(invocationId: string): boolean {
    const record = this.receipts?.get(invocationId);
    return !record || record.state === "pending";
  }
  /** Trusted-main issuance. Neither invoke nor query mints missing identities. */
  issue(call: ActionCall, caller: Omit<TrustedActionContext, "invocationId">): TrustedActionContext {
    const entry = this.resolve(call);
    const action = this.registry.publicAction(call.capabilityId, call.actionId)!;
    checkAccess(this.registry, call.capabilityId, action.permissions, caller);
    const input = normalizeInput(call.input);
    if (!Value.Check(action.inputSchema, input)) throw new InputValidationError(action.inputSchema, input);
    if (!this.receipts) throw new GatewayError("capability_unavailable");
    const context: TrustedActionContext = { callerId: caller.callerId, source: caller.source, permissions: [...caller.permissions], invocationId: randomUUID(), ...(caller.sessionId === undefined ? {} : { sessionId: caller.sessionId }), ...(caller.requireConfirmation === undefined ? {} : { requireConfirmation: caller.requireConfirmation }) };
    const issuedAt = this.now();
    this.receipts.issue({ id: context.invocationId, capabilityId: call.capabilityId, actionId: call.actionId, bindingDigest: this.binding(call, context, entry, input), issuedAt, expiresAt: issuedAt + 15 * 60000 });
    return context;
  }
  /** Query/reconcile only; an absent package receipt never authorizes dispatch. */
  async query(call: ActionCall, context: TrustedActionContext): Promise<GatewayResult> {
    try {
      const entry = this.resolve(call); const action = this.registry.publicAction(call.capabilityId, call.actionId)!;
      checkAccess(this.registry, call.capabilityId, action.permissions, context);
      const record = this.record(call, context, entry, normalizeInput(call.input));
      if (record.result !== undefined) return bounded(record.result) as GatewayResult;
      if (record.state === "issued") throw new GatewayError(record.expiresAt <= this.now() ? "expired" : "reconciliation_required");
      const result = await new TaskArtifactGateway(this.registry, this.receipts, this.now).findByInvocation(call.capabilityId, context.invocationId, context);
      if (result.status === "error") throw new GatewayError(result.error.code);
      if (!result.data) throw new GatewayError("reconciliation_required");
      const recovered: GatewayResult = bounded({ ...this.metadata(call, context, entry), status: "accepted", taskRef: result.data.taskRef, taskStatus: result.data.status });
      this.receipts!.complete(context.invocationId, recovered, result.data.taskRef.taskId, this.now());
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.data.status)) this.receipts!.markTaskTerminal(call.capabilityId, result.data.taskRef.taskId, taskCompletionTime(result.data.finishedAt, this.now()));
      return recovered;
    } catch (error) { return this.failure(call, context, error); }
  }
  async describe(call: ActionCall, context: TrustedActionContext): Promise<DescriptionResult> {
    try {
      const entry = this.resolve(call);
      checkAccess(this.registry, call.capabilityId, entry.declaration.permissions, context);
      return bounded({ ...this.metadata(call, context, entry), status: "described", declaration: entry.declaration, documentation: entry.documentation });
    } catch (error) { return this.failure(call, context, error); }
  }
  async invoke(call: ActionCall, context: TrustedActionContext, mayDispatch?: () => boolean): Promise<GatewayResult> {
    try {
      const entry = this.resolve(call);
      const action = this.registry.publicAction(call.capabilityId, call.actionId);
      if (!action) throw new AppError("capability_unavailable");
      const input = normalizeInput(call.input);
      if (!Value.Check(action.inputSchema, input)) throw new InputValidationError(action.inputSchema, input);
      checkAccess(this.registry, call.capabilityId, action.permissions, context);
      const record = this.record(call, context, entry, input);
      if (record.result !== undefined) return bounded(record.result) as GatewayResult;
      if (record.state !== "issued") throw new GatewayError("reconciliation_required");
      if (record.expiresAt <= this.now()) throw new GatewayError("expired");
      const metadata = this.metadata(call, context, entry);
      const binding = { capabilityId: entry.capabilityId, actionId: entry.actionId, packageVersion: entry.packageVersion, contractDigest: entry.declaration.contractDigest, input };
      let preview: ReturnType<typeof safeOperationPresentation>;
      if (action.presentOperation) {
        try { preview = safeOperationPresentation(await action.presentOperation(JSON.parse(canonicalActionJson(input))), call.capabilityId); }
        catch { /* Optional copy cannot affect authorization or invocation. */ }
      }
      const requiresConfirmation = action.requiresConfirmation || context.requireConfirmation === true
        || action.effects.data === "destructive" || (action.mode === "task" && action.effects.consumesResources);
      if (context.confirmationToken) {
        if (!this.confirmations.consume(context.confirmationToken, binding, context)) throw new GatewayError("confirmation_invalid");
      } else if (requiresConfirmation) {
        let inputSummary: ActionInputPresentation;
        if (action.presentInput) {
          try { inputSummary = validatedPresentation(await action.presentInput(JSON.parse(canonicalActionJson(input)))); }
          catch { throw new GatewayError("presentation_invalid"); }
        } else {
          if (action.effects.data !== "read" || action.effects.consumesResources) throw new GatewayError("presentation_invalid");
          const title = entry.declaration.title.trim();
          inputSummary = { title: title && title.length <= 120 ? title : "确认操作", fields: [] };
        }
        return boundedWithPresentation({ ...metadata, status: "requires_confirmation", confirmationRef: this.confirmations.create(binding, context), inputSummary }, preview);
      }
      // Optional trusted-main revocation guard runs after every asynchronous preview and before dispatch.
      if (mayDispatch && !mayDispatch()) throw new GatewayError("permission_denied");
      if (!this.receipts!.claim(context.invocationId, this.now())) throw new GatewayError("reconciliation_required");
      // Identity fields are selected explicitly. Neither call.input nor arbitrary context extras are forwarded.
      const outcome = await action.handler(input, { invocationId: context.invocationId, source: context.source, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) });
      const { presentation: optionalPresentation, ...coreOutcome } = outcome;
      if (!Value.Check(ActionOutcomeSchema(action.outputSchema), coreOutcome)) throw new AppError("INTERNAL.UNKNOWN");
      const presentation = safeOperationPresentation(optionalPresentation, call.capabilityId);
      // Confirmation references belong to this host, never to package handlers.
      if (outcome.status === "requires_confirmation") throw new AppError("INTERNAL.UNKNOWN");
      if (("taskRef" in outcome && outcome.taskRef && outcome.taskRef.capabilityId !== call.capabilityId)
        || ("artifactRefs" in outcome && outcome.artifactRefs?.some(ref => ref.capabilityId !== call.capabilityId))
        || ("viewRefs" in outcome && outcome.viewRefs?.some(ref => ref.capabilityId !== call.capabilityId))) throw new AppError("INTERNAL.UNKNOWN");
      if (outcome.status === "error") {
        // Reuse the AppError allowlist; never expose a handler's raw message/stack/cause.
        const error = this.failure(call, context, new AppError(outcome.error.code as ConstructorParameters<typeof AppError>[0]));
        return presentation ? { ...error, presentation } : error;
      }
      const resultPresentation = presentation ?? (outcome.status === "accepted" ? preview : undefined);
      const result = boundedWithPresentation({ ...coreOutcome, ...metadata }, resultPresentation);
      this.receipts!.complete(context.invocationId, result, outcome.status === "accepted" ? outcome.taskRef.taskId : undefined, this.now());
      if (outcome.status === "accepted" && ["succeeded", "failed", "cancelled", "interrupted"].includes(outcome.taskStatus)) this.receipts!.markTaskTerminal(call.capabilityId, outcome.taskRef.taskId, this.now());
      return result;
    } catch (error) {
      if (context.confirmationToken) this.confirmations.invalidate(context.confirmationToken);
      return this.failure(call, context, error);
    }
  }
  private binding(call: ActionCall, context: TrustedActionContext, entry: PublicActionEntry, input: unknown): string {
    return createHash("sha256").update(canonicalActionJson({ capabilityId: call.capabilityId, actionId: call.actionId, packageVersion: entry.packageVersion, contractDigest: entry.declaration.contractDigest, inputDigest: createHash("sha256").update(canonicalActionJson(input)).digest("hex"), callerId: context.callerId, source: context.source, sessionId: context.sessionId ?? null })).digest("hex");
  }
  private record(call: ActionCall, context: TrustedActionContext, entry: PublicActionEntry, input: unknown): InvocationRecord {
    const record = this.receipts?.get(context.invocationId);
    if (!record) throw new GatewayError("not_found");
    if (record.bindingDigest !== this.binding(call, context, entry, input)) throw new GatewayError("invocation_invalid");
    return record;
  }
  private resolve(call: ActionCall): PublicActionEntry {
    if (!Value.Check(ActionCallSchema, call)) throw new InputValidationError(ActionCallSchema, call);
    if (!this.registry.readyIds().includes(call.capabilityId)) throw new AppError("capability_unavailable");
    const entry = this.catalog().find(call.capabilityId, call.actionId);
    if (!entry || !this.registry.publicAction(call.capabilityId, call.actionId)) throw new AppError("capability_unavailable");
    if (entry.declaration.contractDigest !== call.contractDigest) throw new GatewayError("contract_changed");
    return entry;
  }
  private metadata(call: ActionCall, context: TrustedActionContext, entry = this.catalog().find(call?.capabilityId, call?.actionId)): ActionResultMetadata {
    const safeText = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "unknown";
    return { capabilityId: safeText(entry?.capabilityId ?? call?.capabilityId), actionId: safeText(entry?.actionId ?? call?.actionId), packageVersion: safeText(entry?.packageVersion),
      contractDigest: entry?.declaration.contractDigest ?? (typeof call?.contractDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(call.contractDigest) ? call.contractDigest : `sha256:${"0".repeat(64)}`), invocationId: safeText(context.invocationId) };
  }
  private failure(call: ActionCall, context: TrustedActionContext, error: unknown): Extract<GatewayResult, { status: "error" }> {
    const metadata = this.metadata(call, context);
    try { return bounded({ ...metadata, status: "error", error: { ...safeGatewayError(error),
      ...(error instanceof InputValidationError ? { fieldErrors: error.fieldErrors } : {}) } }); }
    catch { return { ...metadata, status: "error", error: safeGatewayError(new GatewayError("response_too_large")) }; }
  }
}

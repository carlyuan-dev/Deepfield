import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { canonicalActionJson, TaskScopeProposalSchema, type ActionCall, type CompiledActionDeclaration, type TaskScopeProposal } from "@deepfield/capability-sdk";
import { exactTaskCallDigest } from "./task-authorization.js";

type CatalogEntry = { packageVersion: string; declaration: CompiledActionDeclaration };
export type FrozenTaskScope = TaskScopeProposal & { versions: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeField = (key: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !["constructor", "prototype", "__proto__"].includes(key);
const outputAt = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, key) => safeField(key) && object(current) && Object.hasOwn(current, key) ? current[key] : undefined, value);

export function freezeTaskScope(proposal: TaskScopeProposal, find: (capabilityId: string, actionId: string) => CatalogEntry | undefined): FrozenTaskScope {
  if (!Value.Check(TaskScopeProposalSchema, proposal)) throw new Error("Invalid task scope");
  const scope = structuredClone(proposal); const seen = new Map<string, CatalogEntry>(); const versions: string[] = [];
  for (const rule of scope.rules) {
    const entry = find(rule.call.capabilityId, rule.call.actionId); const policy = entry?.declaration.taskAuthorization;
    if (!entry || policy?.mode !== "scope" || entry.declaration.mode !== "immediate" || entry.declaration.contractDigest !== rule.call.contractDigest
      || !object(rule.call.input) || seen.has(rule.id)) throw new Error("Action does not support this task scope");
    const fields = rule.dynamicFields ?? []; const bindings = Object.entries(rule.bindings ?? {});
    if (entry.declaration.effects.data === "destructive" && (fields.length || bindings.length || rule.maxExecutions !== 1)) throw new Error("Destructive targets must be exact and single-use");
    for (const field of fields) if (!safeField(field) || !policy.dynamicFields.includes(field) || Object.hasOwn(rule.call.input, field)) throw new Error("Undeclared dynamic field");
    for (const [field, ref] of bindings) {
      const prior = seen.get(ref.ruleId); const priorRule = scope.rules.find(item => item.id === ref.ruleId);
      const priorPolicy = prior?.declaration.taskAuthorization;
      if (!safeField(field) || !policy.resourceFields.includes(field) || fields.includes(field) || Object.hasOwn(rule.call.input, field)
        || priorPolicy?.mode !== "scope" || !priorPolicy.outputBindings.includes(ref.path) || priorRule?.maxExecutions !== 1
        || priorRule.call.capabilityId !== rule.call.capabilityId) throw new Error("Resource binding must reference a declared prior successful action");
    }
    seen.set(rule.id, entry); versions.push(entry.packageVersion);
  }
  const frozen = { ...scope, versions };
  const probe = new TaskScopeStore(); probe.activate("validate", "validation", frozen);
  if (probe.claim("validate", scope.firstCall, versions[0]!)?.ruleIndex !== 0) throw new Error("First action is outside the first rule");
  return frozen;
}

export interface ScopeClaim { conversationId: string; grantId: string; ruleIndex: number; digest: string }
/** Volatile authority; persisted proposals and model text can never hydrate grants. */
export class TaskScopeStore {
  private grants = new Map<string, { id: string; scope: FrozenTaskScope; authorityId: string; counts: number[]; digests: Set<string>; results: Map<string, unknown> }>();
  activate(conversationId: string, authorityId: string, scope: FrozenTaskScope): void {
    if (!authorityId) throw new Error("Human confirmation required");
    this.grants.set(conversationId, { id: randomUUID(), scope: structuredClone(scope), authorityId, counts: scope.rules.map(() => 0), digests: new Set(), results: new Map() });
  }
  active(conversationId: string): FrozenTaskScope | undefined { const scope = this.grants.get(conversationId)?.scope; return scope ? structuredClone(scope) : undefined; }
  authority(conversationId: string): { grantId: string; authorityId: string } | undefined {
    const grant = this.grants.get(conversationId); return grant ? { grantId: grant.id, authorityId: grant.authorityId } : undefined;
  }
  claim(conversationId: string, call: ActionCall, packageVersion: string): ScopeClaim | undefined {
    const grant = this.grants.get(conversationId); if (!grant || !object(call.input)) return;
    const digest = exactTaskCallDigest(call, packageVersion); if (grant.digests.has(digest)) return;
    for (const [index, rule] of grant.scope.rules.entries()) {
      if (grant.scope.versions[index] !== packageVersion || rule.call.capabilityId !== call.capabilityId || rule.call.actionId !== call.actionId
        || rule.call.contractDigest !== call.contractDigest || grant.counts[index]! >= rule.maxExecutions) continue;
      const expected = { ...(rule.call.input as Record<string, unknown>) }; let unresolved = false;
      for (const [field, ref] of Object.entries(rule.bindings ?? {})) {
        const value = outputAt(grant.results.get(ref.ruleId), ref.path);
        if (value === undefined || value === null) { unresolved = true; break; } expected[field] = value;
      }
      if (unresolved) continue;
      const actual = { ...call.input };
      for (const field of rule.dynamicFields ?? []) delete actual[field];
      if (canonicalActionJson(actual) !== canonicalActionJson(expected)) continue;
      grant.counts[index] = grant.counts[index]! + 1; grant.digests.add(digest);
      return { conversationId, grantId: grant.id, ruleIndex: index, digest };
    }
  }
  record(claim: ScopeClaim, result: unknown): void {
    if (!this.valid(claim)) return;
    if (!object(result) || result.status !== "completed") { this.revoke(claim.conversationId); return; }
    const grant = this.grants.get(claim.conversationId)!; grant.results.set(grant.scope.rules[claim.ruleIndex]!.id, structuredClone(result));
  }
  valid(claim: ScopeClaim): boolean { return this.grants.get(claim.conversationId)?.id === claim.grantId; }
  revoke(conversationId: string): void { this.grants.delete(conversationId); }
  clear(): void { this.grants.clear(); }
}

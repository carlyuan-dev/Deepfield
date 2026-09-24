import { createHash, randomUUID } from "node:crypto";
import { canonicalActionJson, type ActionCall, type ActionEffects, type TaskAuthorization } from "@deepfield/capability-sdk";

/** Complete supported human phrases only. This is not a natural-language intent parser. */
export function classifyTaskDecision(text: string): "approve_task" | null {
  const normalized = text.trim().replace(/[。.!！]+$/u, "").trim();
  return ["本次一路确认", "本次不用逐个确认", "本次任务不用逐个确认", "这次一路确认", "你一路确认就行，不要我来点",
    "可以，补进去，你一路确认就行，不要我来点"].includes(normalized) ? "approve_task" : null;
}

export interface ExactTaskCandidate {
  call: ActionCall;
  packageVersion: string;
  mode: "immediate" | "task";
  effects: ActionEffects;
  taskAuthorization?: TaskAuthorization;
}
export interface ExactTaskCall { call: ActionCall; packageVersion: string; digest: string }
export const exactTaskCallDigest = (call: ActionCall, packageVersion: string): string =>
  createHash("sha256").update(canonicalActionJson({ call, packageVersion })).digest("hex");

/** Optional family metadata admits a proposal; only exact complete inputs authorize execution. */
export function snapshotExactTaskCalls(candidates: readonly ExactTaskCandidate[]): ExactTaskCall[] {
  if (!candidates.length || candidates.length > 10) throw new Error("本次提案必须包含 1 至 10 个具体操作");
  const first = candidates[0]!; const seen = new Set<string>();
  return candidates.map(item => {
    if (item.taskAuthorization?.mode !== "exact_input" || first.taskAuthorization?.mode !== "exact_input" || !item.taskAuthorization.family || item.mode !== "immediate"
      || item.effects.data === "destructive" || item.call.capabilityId !== first.call.capabilityId
      || item.packageVersion !== first.packageVersion || item.taskAuthorization.family !== first.taskAuthorization?.family)
      throw new Error("该操作不能纳入本次任务授权，请单独确认");
    const call = structuredClone(item.call); const digest = exactTaskCallDigest(call, item.packageVersion);
    if (seen.has(digest)) throw new Error("提案包含重复操作");
    seen.add(digest); return { call, packageVersion: item.packageVersion, digest };
  });
}

export interface TaskGrantClaim { conversationId: string; proposalId: string; grantId: string; digest: string; userMessageId: string }
/** Main/application memory only. Never hydrate authority from a persisted proposal or worker data. */
export class TaskGrantStore {
  private readonly grants = new Map<string, { id: string; proposalId: string; userMessageId: string; digests: string[]; index: number }>();
  activate(conversationId: string, proposalId: string, userMessageId: string, calls: readonly ExactTaskCall[]): void {
    if (!userMessageId || !calls.length || calls.length > 10) throw new Error("Invalid task authorization");
    this.grants.set(conversationId, { id: randomUUID(), proposalId, userMessageId, digests: calls.map(call => call.digest), index: 0 });
  }
  claim(conversationId: string, proposalId: string, digest: string): TaskGrantClaim | undefined {
    const grant = this.grants.get(conversationId);
    if (!grant || grant.proposalId !== proposalId || grant.digests[grant.index] !== digest) return;
    grant.index++;
    return { conversationId, proposalId, grantId: grant.id, digest, userMessageId: grant.userMessageId };
  }
  valid(claim: TaskGrantClaim): boolean { return this.grants.get(claim.conversationId)?.id === claim.grantId; }
  revoke(conversationId: string): void { this.grants.delete(conversationId); }
  clear(): void { this.grants.clear(); }
}

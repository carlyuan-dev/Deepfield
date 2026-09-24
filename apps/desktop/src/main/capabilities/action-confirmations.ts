import { randomUUID } from "node:crypto";
import { canonicalActionJson, type ActionInvocationContext } from "@deepfield/capability-sdk";

/** Constructed by main-process callers. Never deserialize this from model/renderer input. */
export interface TrustedActionContext extends ActionInvocationContext {
  callerId: string;
  permissions: readonly string[];
  confirmationToken?: string;
  requireConfirmation?: boolean;
}
export interface ConfirmationBinding {
  capabilityId: string;
  actionId: string;
  packageVersion: string;
  contractDigest: string;
  input: unknown;
}
interface PendingConfirmation {
  binding: ConfirmationBinding;
  owner: string;
  bindingKey: string;
  expiresAt: number;
  token?: string;
  timer: ReturnType<typeof setTimeout>;
}
function owner(context: TrustedActionContext): string {
  return canonicalActionJson({ callerId: context.callerId, source: context.source, sessionId: context.sessionId ?? null, invocationId: context.invocationId });
}

/** Main-only approval port. Single-use, short-lived authorization; no persistent idempotency. */
export class ActionConfirmations {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly tokens = new Map<string, string>();
  private disposed = false;
  constructor(private readonly ttlMs = 5 * 60_000, private readonly now = Date.now) {}
  create(binding: ConfirmationBinding, context: TrustedActionContext): string {
    if (this.disposed) throw new Error("confirmations_disposed");
    const ref = randomUUID();
    const timer = setTimeout(() => this.remove(ref), this.ttlMs); timer.unref();
    this.pending.set(ref, { binding: structuredClone(binding), bindingKey: canonicalActionJson(binding), owner: owner(context), expiresAt: this.now() + this.ttlMs, timer });
    return ref;
  }
  approve(ref: string, context: TrustedActionContext): string | undefined {
    const pending = this.get(ref);
    if (!pending || pending.owner !== owner(context)) return undefined;
    // Repeated approval returns the same token, never an additional authorization.
    if (!pending.token) { pending.token = randomUUID(); this.tokens.set(pending.token, ref); }
    return pending.token;
  }
  /** The approval UI reads the stored parameters, never a second model-supplied summary. */
  inspect(ref: string, context: TrustedActionContext): ConfirmationBinding | undefined {
    const pending = this.get(ref);
    return pending?.owner === owner(context) ? structuredClone(pending.binding) : undefined;
  }
  consume(token: string, binding: ConfirmationBinding, context: TrustedActionContext): boolean {
    const ref = this.tokens.get(token);
    if (!ref) return false;
    const pending = this.get(ref);
    this.remove(ref); // atomic before any asynchronous handler work, including mismatched attempts
    return !!pending && pending.owner === owner(context) && pending.bindingKey === canonicalActionJson(binding);
  }
  invalidate(token: string): void {
    const ref = this.tokens.get(token);
    if (ref) this.remove(ref);
  }
  dismiss(ref: string, context: TrustedActionContext): boolean {
    const pending = this.get(ref);
    if (!pending || pending.owner !== owner(context)) return false;
    this.remove(ref); return true;
  }
  revokeCapability(capabilityId: string): void {
    for (const [ref, pending] of this.pending) if (pending.binding.capabilityId === capabilityId) this.remove(ref);
  }
  dispose(): void { this.disposed = true; for (const ref of this.pending.keys()) this.remove(ref); }
  private get(ref: string): PendingConfirmation | undefined {
    const pending = this.pending.get(ref);
    if (pending && pending.expiresAt <= this.now()) { this.remove(ref); return undefined; }
    return pending;
  }
  private remove(ref: string): void {
    const pending = this.pending.get(ref);
    if (pending) { clearTimeout(pending.timer); if (pending.token) this.tokens.delete(pending.token); }
    this.pending.delete(ref);
  }
}

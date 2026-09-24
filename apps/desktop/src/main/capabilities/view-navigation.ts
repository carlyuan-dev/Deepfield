import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { DraftRefSchema, ViewRefSchema, ViewOpenResultSchema, type CapabilityNavigationEvent, type CapabilityNavigationRequest, type CapabilityUiOpenTarget, type ViewOpenResult, type ViewResolution } from "@deepfield/capability-sdk";

const blocked = (message: string): ViewOpenResult => ({ status: "blocked", message });
interface Pending {
  request: CapabilityNavigationRequest;
  owner: number;
  finish(result: ViewOpenResult): void;
}

/** Trusted main-process entrypoint. Resolution never counts as UI success. */
export class ViewNavigation {
  private renderer: { owner: number; send(event: CapabilityNavigationEvent): void } | undefined;
  private pending: Pending | undefined;
  private readonly retries = new Map<string, { owner: number; target: CapabilityUiOpenTarget; signal?: AbortSignal }>();
  private disposed = false;
  private manualEpoch = 0;
  constructor(private readonly resolve: (target: CapabilityUiOpenTarget) => Promise<ViewResolution>, private readonly timeoutMs = 10_000) {}
  manualGeneration(): number { return this.manualEpoch; }
  noteManualNavigation(): void {
    this.manualEpoch += 1;
    this.pending?.finish(blocked("manual_navigation"));
  }
  attach(owner: number, send: (event: CapabilityNavigationEvent) => void): () => void {
    this.detach();
    this.renderer = { owner, send };
    return () => { if (this.renderer?.send === send) this.detach(); };
  }
  private detach() {
    this.pending?.finish(blocked("renderer_unavailable"));
    this.renderer = undefined;
    this.retries.clear();
  }
  open(target: CapabilityUiOpenTarget, signal?: AbortSignal): Promise<ViewOpenResult> {
    if (signal?.aborted) return Promise.resolve(blocked("origin_inactive"));
    if (!Value.Check(ViewRefSchema, target) && !Value.Check(DraftRefSchema, target)) return Promise.resolve({ status: "not_found", message: "invalid_target" });
    if (this.disposed) return Promise.resolve(blocked("renderer_unavailable"));
    if (this.pending) return Promise.resolve(blocked("navigation_busy"));
    const renderer = this.renderer;
    const copy = JSON.parse(JSON.stringify(target)) as CapabilityUiOpenTarget;
    const request: CapabilityNavigationRequest = { kind: "open", requestId: randomUUID(), target: copy,
      view: { capabilityId: target.capabilityId, viewId: "pending", input: {} }, expiresAt: Date.now() + this.timeoutMs };
    return new Promise(resolve => {
      const timer = setTimeout(() => pending.finish(blocked("navigation_timeout")), this.timeoutMs);
      const abort = () => pending.finish(blocked("origin_inactive"));
      const pending: Pending = { request, owner: renderer?.owner ?? -1, finish: result => {
        if (this.pending !== pending) return;
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer); this.pending = undefined;
        if (result.status !== "opened") {
          try { renderer?.send({ kind: "cancel", requestId: request.requestId }); } catch { /* closed */ }
        }
        if (renderer && result.status === "blocked" && result.message === "unsaved_input") {
          this.retries.set(request.requestId, { owner: renderer.owner, target: copy, ...(signal ? { signal } : {}) });
          if (this.retries.size > 20) this.retries.delete(this.retries.keys().next().value!);
        }
        resolve(result);
      } };
      this.pending = pending;
      signal?.addEventListener("abort", abort, { once: true });
      void this.resolve(copy).then(resolution => {
        if (this.pending !== pending) return;
        if (resolution.status !== "resolved") { pending.finish(resolution); return; }
        if (!renderer || this.renderer !== renderer) { pending.finish(blocked("renderer_unavailable")); return; }
        request.view = resolution.view;
        try { renderer.send(request); } catch { pending.finish(blocked("renderer_unavailable")); }
      }, () => pending.finish(blocked("view_resolution_failed")));
    });
  }
  ack(owner: number, requestId: string, capabilityId: string, result: ViewOpenResult): boolean {
    const pending = this.pending;
    if (!pending || pending.owner !== owner || pending.request.requestId !== requestId || pending.request.target.capabilityId !== capabilityId || Date.now() >= pending.request.expiresAt || !Value.Check(ViewOpenResultSchema, result)) return false;
    pending.finish(result); return true;
  }
  retry(owner: number, requestId: string): Promise<ViewOpenResult> {
    const saved = this.retries.get(requestId);
    if (!saved || saved.owner !== owner) return Promise.resolve({ status: "not_found" });
    this.retries.delete(requestId);
    return this.open(saved.target, saved.signal);
  }
  revokeCapability(capabilityId: string) {
    if (this.pending?.request.target.capabilityId === capabilityId) this.pending.finish(blocked("capability_unavailable"));
    for (const [id, saved] of this.retries) if (saved.target.capabilityId === capabilityId) this.retries.delete(id);
  }
  dispose() { this.disposed = true; this.detach(); }
}

import type { CapabilityNavigationRequest, CapabilityUiNavigationHandler, ViewOpenResult } from "@deepfield/capability-sdk";

/** Owns only interaction lifetime; draft content remains package-owned. */
export class CapabilityInteractionState {
  constructor(private readonly applyChange: (change: () => void) => void = change => change()) {}
  private mounted: string | undefined;
  private handler: CapabilityUiNavigationHandler | undefined;
  private loading = false;
  private failed = false;
  private waiter: (() => void) | undefined;
  private current: { id: string; targetId: string; abort: AbortController; rollback?: (() => void) | undefined } | undefined;
  mount(id: string) { this.mounted = id; this.handler = undefined; this.loading = true; this.failed = false; }
  fail(id: string) { if (this.mounted === id) { this.failed = true; this.loading = false; this.waiter?.(); } }
  ready(id: string) { if (this.mounted === id) { this.loading = false; this.waiter?.(); } }
  register(id: string, handler: CapabilityUiNavigationHandler) {
    if (this.mounted !== id) return () => {};
    this.handler = handler;
    this.loading = false; this.waiter?.();
    return () => { if (this.handler === handler) this.handler = undefined; };
  }
  unmount(id: string) {
    if (this.mounted === id) { this.mounted = undefined; this.handler = undefined; this.loading = false; }
    if (this.current?.targetId === id) this.cancel(this.current.id);
  }
  private rollback(current: NonNullable<CapabilityInteractionState["current"]>) {
    const restore = current.rollback;
    current.rollback = undefined;
    if (!restore) return;
    // Every automatic exit must consult the currently registered guard, including
    // cancellation and handlers replaced while asynchronous preparation was running.
    if (this.mounted === current.targetId && !this.loading) {
      try { if (this.handler?.canLeave() !== true) return; }
      catch { return; } // Unknown safety must not discard a mounted page.
    }
    restore();
  }
  cancel(id?: string, restore = true) {
    if (this.current && (!id || this.current.id === id)) {
      this.current.abort.abort();
      if (restore) this.rollback(this.current);
      else this.current.rollback = undefined;
      this.waiter?.();
    }
  }
  async open(request: CapabilityNavigationRequest, select: (id: string) => void | (() => void)): Promise<ViewOpenResult> {
    this.cancel();
    const current: NonNullable<CapabilityInteractionState["current"]> = { id: request.requestId, targetId: request.target.capabilityId, abort: new AbortController() };
    this.current = current;
    const valid = () => this.current === current && !current.abort.signal.aborted && Date.now() < request.expiresAt;
    const timer = setTimeout(() => { current.abort.abort(); this.waiter?.(); }, Math.max(0, request.expiresAt - Date.now()));
    const cancelled = new Promise<never>((_resolve, reject) => current.abort.signal.addEventListener("abort", () => reject(new Error("navigation_cancelled")), { once: true }));
    // Attach immediately, even while waiting for a package module to load.
    void cancelled.catch(() => {});
    let opened = false;
    try {
      if (this.loading) await new Promise<void>(resolve => { this.waiter = resolve; });
      if (!valid()) return { status: "blocked", message: "navigation_cancelled" };
      // Legacy pages cannot attest to safe semantic replacement; sidebar remains available.
      if (this.mounted && !this.handler) return { status: "unsupported" };
      if (this.failed) return { status: "blocked", message: "ui_load_failed" };
      if (this.handler && this.handler.canLeave() !== true) return { status: "blocked", message: "unsaved_input" };
      if (!valid()) return { status: "blocked", message: "navigation_cancelled" };
      if (this.mounted !== request.target.capabilityId) {
        const loaded = new Promise<void>(resolve => { this.waiter = resolve; });
        current.rollback = select(request.target.capabilityId) || undefined;
        await loaded;
      }
      if (!valid()) return { status: "blocked", message: "navigation_cancelled" };
      if (this.failed) return { status: "blocked", message: "ui_load_failed" };
      const handler = this.handler;
      if (!handler || this.mounted !== request.target.capabilityId) return { status: "unsupported", message: "ui_unavailable" };
      let committed = false;
      let blockedByInput = false;
      const result = await Promise.race([handler.open(request.target, {
        view: request.view, signal: current.abort.signal,
        commit: change => {
          if (!valid() || this.handler !== handler || this.mounted !== request.target.capabilityId) return false;
          if (blockedByInput || handler.canLeave() !== true) {
            blockedByInput = true;
            return false;
          }
          this.applyChange(change);
          if (!valid() || this.failed || this.mounted !== request.target.capabilityId) return false;
          committed = true; return true;
        },
      }), cancelled]);
      if (!valid()) return { status: "blocked", message: "navigation_cancelled" };
      if (blockedByInput) return { status: "blocked", message: "unsaved_input" };
      if (result.status === "opened" && !committed) return { status: "blocked", message: "ui_not_committed" };
      opened = result.status === "opened";
      return result;
    } catch { return { status: "blocked", message: current.abort.signal.aborted ? "navigation_cancelled" : "ui_load_failed" }; }
    finally { clearTimeout(timer); if (!opened) this.rollback(current); current.rollback = undefined; if (this.current === current) { this.current = undefined; this.waiter = undefined; } }
  }
}

import { expect, it, vi } from "vitest";
import { CapabilityInteractionState } from "./interaction-state.js";

const target = { capabilityId: "records", viewId: "detail", input: {} };
const request = () => ({ kind: "open" as const, requestId: "r", target, view: target, expiresAt: Date.now() + 1000 });
it.each(["timeout", "cancel", "handler replacement"])("keeps newly edited cross-package target mounted after %s", async mode => {
  vi.useFakeTimers();
  try {
    const state = new CapabilityInteractionState();
    const dirty = { current: false };
    let content = "original";
    let selected = "current";
    let release!: () => void;
    let started!: () => void;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    state.mount("current");
    state.register("current", { canLeave: () => true, open: async () => ({ status: "opened" }) });
    const pending = state.open(request(), id => {
      selected = id;
      state.mount(id);
      state.register(id, { canLeave: () => !dirty.current, open: async (_target, context) => {
        started();
        await new Promise<void>(resolve => { release = resolve; });
        return { status: context.commit(() => { content = "replacement"; }) ? "opened" : "blocked" };
      } });
      return () => { selected = "current"; content = "previous page"; };
    });
    await preparing;
    content = "new unsaved input";
    dirty.current = true;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (mode === "cancel") state.cancel("r");
    else {
      state.register("records", { canLeave: () => !dirty.current, open: async () => ({ status: "blocked" }) });
      release();
    }
    expect((await pending).status).toBe("blocked");
    expect(selected).toBe("records");
    expect(content).toBe("new unsaved input");
    release();
    await Promise.resolve();
    expect(content).toBe("new unsaved input");
  } finally { vi.useRealTimers(); }
});
it.each([false, true])("preserves edits made during deferred preparation with a stable handler (cross-package=%s)", async crossPackage => {
  const state = new CapabilityInteractionState();
  const dirty = { current: false };
  let content = "original";
  let selected = crossPackage ? "current" : "records";
  let release!: () => void;
  let started!: () => void;
  const preparing = new Promise<void>(resolve => { started = resolve; });
  const registerTarget = () => {
    state.mount("records");
    state.register("records", { canLeave: () => !dirty.current, open: async (_target, context) => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return { status: context.commit(() => { content = "replacement"; }) ? "opened" : "blocked" };
    } });
  };
  if (crossPackage) {
    state.mount("current");
    state.register("current", { canLeave: () => true, open: async () => ({ status: "opened" }) });
  } else registerTarget();
  const pending = state.open(request(), id => {
    selected = id; registerTarget();
    return () => { selected = "current"; content = "previous page"; };
  });
  await preparing;
  content = "new unsaved input";
  dirty.current = true;
  release();
  expect(await pending).toEqual({ status: "blocked", message: "unsaved_input" });
  expect(content).toBe("new unsaved input");
  expect(selected).toBe("records");
});
it("keeps unsaved input and does not switch packages when leaving is blocked", async () => {
  const state = new CapabilityInteractionState();
  let content = "unsaved";
  state.mount("current");
  state.register("current", { canLeave: () => false, open: async () => ({ status: "opened" }) });
  const result = await state.open(request(), () => { content = "lost"; });
  expect(result).toEqual({ status: "blocked", message: "unsaved_input" });
  expect(content).toBe("unsaved");
});
it("guards same-package navigation and requires a committed UI change before opened", async () => {
  const state = new CapabilityInteractionState();
  state.mount("records");
  state.register("records", { canLeave: () => false, open: async () => ({ status: "opened" }) });
  expect((await state.open(request(), () => {})).status).toBe("blocked");
  state.register("records", { canLeave: () => true, open: async () => ({ status: "opened" }) });
  expect(await state.open(request(), () => {})).toEqual({ status: "blocked", message: "ui_not_committed" });
});
it("rolls back an unready cross-package selection on timeout without allowing a late open", async () => {
  vi.useFakeTimers();
  const state = new CapabilityInteractionState();
  state.mount("current");
  state.register("current", { canLeave: () => true, open: async () => ({ status: "opened" }) });
  let selected = "current";
  let lateOpen = false;
  const pending = state.open(request(), id => { selected = id; state.unmount("current"); state.mount(id); return () => { selected = "current"; }; });
  await vi.advanceTimersByTimeAsync(1001);
  expect((await pending).status).toBe("blocked");
  expect(selected).toBe("current");
  state.register("records", { canLeave: () => true, open: async () => { lateOpen = true; return { status: "opened" }; } });
  state.ready("records");
  expect(lateOpen).toBe(false);
  vi.useRealTimers();
});
it("does not navigate from ordinary background activity", () => {
  const state = new CapabilityInteractionState();
  let content = "unchanged";
  state.mount("records");
  state.register("records", { canLeave: () => true, open: async () => { content = "changed"; return { status: "opened" }; } });
  expect(content).toBe("unchanged");
});
it("revokes commits while an asynchronous open is pending", async () => {
  const state = new CapabilityInteractionState();
  let finish!: () => void;
  let content = "original";
  state.mount("records");
  state.register("records", { canLeave: () => true, open: async (_target, context) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return context.commit(() => { content = "late"; }) ? { status: "opened" } : { status: "blocked" };
  } });
  const pending = state.open(request(), () => {});
  await Promise.resolve(); await Promise.resolve();
  state.cancel("r"); finish();
  expect((await pending).status).toBe("blocked");
  expect(content).toBe("original");
});

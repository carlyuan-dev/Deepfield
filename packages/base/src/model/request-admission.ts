import { AsyncLocalStorage } from "node:async_hooks";

/** Host-supplied resource admission. Runs once per actual HTTP attempt, before Usage. */
const admission = new AsyncLocalStorage<() => void>();

export function withModelRequestAdmission<T>(guard: () => void, work: () => T): T {
  const parent = admission.getStore();
  return admission.run(parent ? () => { parent(); guard(); } : guard, work);
}

export function admitModelRequest(): void { admission.getStore()?.(); }

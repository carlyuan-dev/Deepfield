import type { Static, TSchema } from "typebox";
import type { Cleanup } from "./lifecycle.js";
import type { RegisteredAction } from "./actions.js";
import type { CapabilityFormDefinition, CapabilityFormProvider } from "./forms.js";
import type { ArtifactProvider, TaskProvider, ViewProvider } from "./interaction.js";

/** A registrar is scoped by its host; packages cannot choose another package's identity. */
export interface CapabilityRegistrar {
  register<I extends TSchema, O extends TSchema>(operation: string, input: I, output: O, handler: (input: Static<I>) => Static<O> | Promise<Static<O>>): Cleanup;
  /** v2 only. Packages must fail activation explicitly when the host omits it. */
  registerAction?<I extends TSchema, O extends TSchema>(action: RegisteredAction<I, O>): Cleanup;
  registerFormProvider?(definitions: readonly CapabilityFormDefinition[], provider: CapabilityFormProvider): Cleanup;
  registerTaskProvider?(provider: TaskProvider): Cleanup;
  registerArtifactProvider?(provider: ArtifactProvider): Cleanup;
  registerViewProvider?(provider: ViewProvider): Cleanup;
  registerTopic(topic: string, payload: TSchema): Cleanup;
  emit(topic: string, payload: unknown): void;
  defer(cleanup: Cleanup): void;
  onReady(start: () => void | Promise<void>): void;
}
export interface CapabilityWorkerRegistrar {
  register<I extends TSchema, O extends TSchema>(operation: string, input: I, output: O, handler: (input: Static<I>, emit: (payload: Static<O>, terminal?: "completed" | "failed" | "cancelled") => void, signal: AbortSignal) => Promise<void>): Cleanup;
  defer(cleanup: Cleanup): void;
}

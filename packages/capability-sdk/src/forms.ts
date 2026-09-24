import type { DraftRef, ViewRef } from "./interaction.js";

/** Package-owned form catalog. Inputs and step details are read from a draft on demand. */
export interface CapabilityFormDefinition {
  id: string;
  actionIds: readonly string[];
  description: string;
}

export interface CapabilityFormSnapshot {
  draft: DraftRef;
  view: ViewRef;
  /** Optional package-owned page displayed underneath the shared form. */
  parentView?: ViewRef;
  values: unknown;
  inputSchema: unknown;
  step?: string;
  transitions: readonly { id: string; label: string }[];
  readyToSubmit: boolean;
  /** Human-readable current values; no machine references or contract metadata. */
  summary?: string;
}

export interface CapabilityFormSubmission {
  actionId: string;
  input: unknown;
  /** Opaque package draft revision used to bind the final action input. */
  revision: string;
}

export interface CapabilityFormProvider {
  prepare(formId: string, actionId: string, input: unknown): Promise<CapabilityFormSnapshot>;
  read(ref: DraftRef): Promise<CapabilityFormSnapshot>;
  update(ref: DraftRef, patch: unknown): Promise<CapabilityFormSnapshot>;
  transition(ref: DraftRef, transitionId: string): Promise<CapabilityFormSnapshot>;
  validate(ref: DraftRef): Promise<{ valid: boolean; fieldErrors: { path: string; message: string }[] }>;
  /** Converts a validated draft into existing action input; execution remains in the action gateway. */
  submission(ref: DraftRef): Promise<CapabilityFormSubmission>;
  /** Apply a real successful action receipt and optionally prepare a separately approved next step. */
  afterAction?(ref: DraftRef, actionId: string, outcome: unknown): Promise<{ snapshot: CapabilityFormSnapshot; nextActionId: string } | undefined>;
  release(ref: DraftRef): Promise<void>;
}

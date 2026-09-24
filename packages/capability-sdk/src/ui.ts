import type * as React from "react";
import type * as JsxRuntime from "react/jsx-runtime";
import type { DraftRef, ViewRef, ViewOpenResult } from "./interaction.js";
import type { CapabilityFormSnapshot } from "./forms.js";

export type CapabilityUiOpenTarget = ViewRef | DraftRef;
export type CapabilityUiOpenResult = ViewOpenResult;

export interface CapabilityUiNavigationHandler {
  /** Synchronous, side-effect-free check of current dirty state (read a ref in stable handlers). */
  canLeave(): boolean;
  /** All visible state changes must run synchronously inside context.commit. */
  open(target: CapabilityUiOpenTarget, context: {
    view: ViewRef;
    signal: AbortSignal;
    commit(change: () => void): boolean;
  }): Promise<ViewOpenResult>;
}
export interface CapabilityUiNavigation {
  register(handler: CapabilityUiNavigationHandler): () => void;
}

export interface CapabilityNavigationRequest {
  kind: "open";
  requestId: string;
  target: CapabilityUiOpenTarget;
  view: ViewRef;
  expiresAt: number;
}
export type CapabilityNavigationEvent = CapabilityNavigationRequest | { kind: "cancel"; requestId: string };
/** Host-only transport, never passed to a package UI or model. */
export interface CapabilityNavigationBridge {
  subscribe(listener: (event: CapabilityNavigationEvent) => void): () => void;
  ack(requestId: string, capabilityId: string, result: ViewOpenResult): Promise<boolean>;
  retry(requestId: string): Promise<ViewOpenResult>;
  /** Trusted window reports direct user navigation, invalidating pending automatic opens. */
  noteManualNavigation?(): Promise<void>;
}

export interface CapabilityCall {
  capabilityId: string;
  operation: string;
  requestId: string;
  input: unknown;
}

export interface CapabilityEvent {
  capabilityId: string;
  topic: string;
  payload: unknown;
}

/** Transport only. The host validates readiness, operation and payload. */
export interface CapabilityBridge {
  invoke(call: CapabilityCall): Promise<unknown>;
  subscribe(listener: (event: CapabilityEvent) => void): () => void;
}

export interface CapabilityUiRuntime {
  react: Pick<typeof React, "useCallback" | "useEffect" | "useMemo" | "useRef" | "useState" | "useId">;
  jsx: Pick<typeof JsxRuntime, "jsx" | "jsxs" | "Fragment">;
  Modal: React.ComponentType<{ title: string; onClose(): void; active?: boolean; children: React.ReactNode }>;
  MarkdownMessage: React.ComponentType<{ content: string }>;
  UrlPopoverLink: React.ComponentType<Omit<React.ComponentPropsWithoutRef<"a">, "href"> & { href: string; children: React.ReactNode }>;
  isSafeHttpUrl(value: string): boolean;
}

/** Bound by the host to one interaction and package; no arbitrary conversation selector or approval token. */
export interface CapabilityInteractionEditor {
  read(): Promise<{ revision: number; status: string; formId: string; actionId: string; snapshot: CapabilityFormSnapshot }>;
  beginEdit(expectedRevision: number): Promise<void>;
  update(expectedRevision: number, patch: unknown): Promise<{ revision: number }>;
  transition(expectedRevision: number, transitionId: string): Promise<{ revision: number }>;
  respond(expectedRevision: number, decision: "approve" | "cancel"): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface CapabilityUiProps {
  navigation?: CapabilityUiNavigation;
  interactionEditor?: CapabilityInteractionEditor;
  active?: boolean;
  bridge: CapabilityBridge;
  onClose(): void;
  onOpenSettings(module: "llm" | "search"): void;
}

export interface CapabilityUiModule {
  cssPaths?: readonly string[];
  createView(runtime: CapabilityUiRuntime): React.ComponentType<CapabilityUiProps>;
}

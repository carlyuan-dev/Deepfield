import type * as React from "react";
import type * as JsxRuntime from "react/jsx-runtime";

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

export interface CapabilityUiProps {
  bridge: CapabilityBridge;
  onClose(): void;
  onOpenSettings(module: "llm" | "search"): void;
}

export interface CapabilityUiModule {
  createView(runtime: CapabilityUiRuntime): React.ComponentType<CapabilityUiProps>;
}

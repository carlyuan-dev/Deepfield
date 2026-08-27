import { ToolExecutionError } from "@deepfield/tool-platform";
import type { TextItem } from "./pdf-text.js";

export interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly TextItem[] }>;
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getMetadata(): Promise<{ info: Record<string, unknown> }>;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

/** Narrow loader contract: a pdfjs-like loading task with a destroyable promise. */
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  /** Must settle (rejections are observed and sanitized by the tool). */
  destroy(): Promise<void>;
}

export type PdfLoader = (data: Uint8Array) => PdfLoadingTaskLike;

export interface AbortGuard {
  race<T>(promise: Promise<T>): Promise<T>;
  addAbortListener(listener: () => void): () => void;
}

/**
 * Shared abort deferred: every key await races it, so cancellation never
 * depends on the third-party promise rejecting on destroy. The deferred is
 * marked handled so an abort between awaits cannot surface an unhandled
 * rejection.
 */
export function createAbortGuard(signal: AbortSignal): AbortGuard {
  let abortReject: (() => void) | undefined;
  const abortDeferred = new Promise<never>((_resolve, reject) => {
    abortReject = () => reject(new ToolExecutionError("cancelled"));
  });
  void abortDeferred.catch(() => {});
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, abortDeferred]);
  const addAbortListener = (listener: () => void): (() => void) => {
    const onAbort = (): void => {
      abortReject?.(); // never throws synchronously
      listener();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  };
  return { race, addAbortListener };
}

/**
 * Single canonical destroy owner: at most one destroy is started per loading
 * task, memoized, and any rejection is observed + sanitized. A hostile
 * never-settling destroy cannot hang a cancelled execution when the caller
 * chooses not to await it. The getter reads the CURRENT task so the guard can
 * be created before the loader assigns it.
 */
export function createMemoizedDestroy(
  getTask: () => PdfLoadingTaskLike | undefined,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () => {
    const task = getTask();
    if (task === undefined) {
      return Promise.resolve();
    }
    if (cleanup === undefined) {
      cleanup = Promise.resolve()
        .then(() => task.destroy())
        .then(
          () => undefined,
          () => undefined,
        );
    }
    return cleanup;
  };
}

/** A run-local signal that stops Pi after the current tool turn is paired. */
export interface ExecutionHandoff {
  request(): void;
  isRequested(): boolean;
}

export function createExecutionHandoff(): ExecutionHandoff {
  let requested = false;
  return {
    request: () => { requested = true; },
    isRequested: () => requested,
  };
}

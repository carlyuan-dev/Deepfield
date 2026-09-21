interface ActivationContext {
  record(value: string): void;
}

export async function activate(
  context: ActivationContext,
  defer: (cleanup: () => void) => void,
): Promise<void> {
  context.record("worker:activate");
  defer(() => context.record("worker:cleanup"));
}

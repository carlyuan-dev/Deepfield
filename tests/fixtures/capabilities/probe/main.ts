interface ActivationContext {
  record(value: string): void;
}

export async function activate(
  context: ActivationContext,
  defer: (cleanup: () => void) => void,
): Promise<void> {
  context.record("main:activate");
  defer(() => context.record("main:cleanup"));
}

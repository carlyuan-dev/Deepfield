interface ActivationContext {
  record(value: string): void;
}

const moduleMarkers = (globalThis as unknown as Record<string, unknown>).__deepfieldCapabilityProbeMarkers;
if (Array.isArray(moduleMarkers)) moduleMarkers.push("worker:module");

export async function activate(
  context: ActivationContext,
  defer: (cleanup: () => void) => void,
): Promise<void> {
  context.record("worker:activate");
  defer(() => context.record("worker:cleanup"));
}

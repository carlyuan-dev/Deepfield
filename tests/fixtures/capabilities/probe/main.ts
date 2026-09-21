interface ActivationContext {
  record(value: string): void;
}

const moduleMarkers = (globalThis as unknown as Record<string, unknown>).__deepfieldCapabilityProbeMarkers;
if (Array.isArray(moduleMarkers)) moduleMarkers.push("main:module");

export async function activate(
  context: ActivationContext,
  defer: (cleanup: () => void) => void,
): Promise<void> {
  context.record("main:activate");
  defer(() => context.record("main:cleanup"));
}

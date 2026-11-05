import { getCapabilityTrace, type CapabilityHostServices } from "@deepfield/capability-sdk";
import { createTracePort } from "@deepfield/base/trace/runtime";

/** Only the trusted loader binds package ownership; never a package-supplied ID. */
export function scopeCapabilityTrace(services: CapabilityHostServices, capabilityId: string, defer: (cleanup: () => void) => void): CapabilityHostServices {
  if (!getCapabilityTrace(services)) return services;
  const trace = createTracePort(capabilityId); defer(() => trace.dispose());
  return Object.freeze({ version: 1 as const, has: (name: string) => services.has(name),
    get<T>(name: string): T { return name === "trace.v1" ? trace as T : services.get<T>(name); },
  });
}

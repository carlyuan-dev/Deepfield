import type { ScopedConfigService } from "@deepfield/base/config";
import type { CapabilityHostServices } from "@deepfield/capability-sdk";

/** Only the trusted host chooses the scope; a package receives this service view. */
export function createCapabilityConfigServices(base: CapabilityHostServices, service: ScopedConfigService): CapabilityHostServices {
  return Object.freeze({
    version: 1 as const,
    has: (name: string) => name === "config.v1" || base.has(name),
    get<T>(name: string): T { return name === "config.v1" ? service as T : base.get<T>(name); },
  });
}

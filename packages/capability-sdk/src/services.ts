import type { TracePort } from "@deepfield/base/trace";

/** Versioned, named adapters. Packages own construction; the host owns availability. */
export interface CapabilityHostServices {
  readonly version: 1;
  has(name: string): boolean;
  get<T>(name: string): T;
}

export function createCapabilityHostServices(adapters: Readonly<Record<string, unknown>>): CapabilityHostServices {
  const values = new Map(Object.entries(adapters));
  return Object.freeze({
    version: 1 as const,
    has: (name: string) => values.has(name) && values.get(name) !== undefined,
    get<T>(name: string): T {
      if (!values.has(name) || values.get(name) === undefined) throw new Error("missing_host_service");
      return values.get(name) as T;
    },
  });
}

/** Optional host observation. Only types cross the SDK boundary; the host owns ALS. */
export function getCapabilityTrace(services: CapabilityHostServices | undefined): TracePort | undefined {
  try {
    if (services?.version !== 1 || !services.has("trace.v1")) return undefined;
    const port = services.get<TracePort | undefined>("trace.v1");
    if (port?.version !== 1 || ![port.capture, port.run, port.start, port.link, port.find, port.dispose].every(value => typeof value === "function")) return undefined;
    return port;
  } catch { return undefined; }
}

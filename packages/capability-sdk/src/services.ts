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

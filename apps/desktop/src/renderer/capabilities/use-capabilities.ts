import { useEffect, useState } from "react";
import type { CapabilityManagementApi, CapabilitySnapshot } from "@deepfield/contracts";

export function useCapabilities(api: CapabilityManagementApi) {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true; let revision = 0;
    const unsubscribe = api.subscribe(value => { revision++; if (alive) { setSnapshot(value); setError(false); } });
    const current = revision;
    void api.list().then(value => { if (alive && revision === current) setSnapshot(value); }, () => { if (alive && revision === current) setError(true); });
    return () => { alive = false; unsubscribe(); };
  }, [api]);
  return { snapshot, error };
}

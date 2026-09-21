import { useMemo } from "react";
import type { DesktopApi } from "@deepfield/contracts";
import type { CapabilityBridge, CapabilityUiProps } from "@deepfield/capability-sdk";
import { IndustryResearchCapability } from "./IndustryResearchCapability.js";

/** Temporary adapter for the existing page. Package migration owns these operations. */
function researchApi(bridge: CapabilityBridge): DesktopApi {
  const namespaces = ["industryResearch", "companyResearch", "companyResearchBatch", "settings"];
  return Object.fromEntries(namespaces.map(namespace => [namespace, new Proxy({}, {
    get(_target, method: string) {
      const operation = `${namespace}.${method}`;
      if (method.startsWith("subscribe")) return (listener: (event: unknown) => void) => bridge.subscribe(event => {
        if (event.capabilityId === "company-research" && event.topic === operation) listener(event.payload);
      });
      return (...input: unknown[]) => bridge.invoke({ capabilityId: "company-research", operation, requestId: crypto.randomUUID(), input });
    },
  })])) as unknown as DesktopApi;
}

export function View({ bridge, onClose, onOpenSettings }: CapabilityUiProps) {
  const api = useMemo(() => researchApi(bridge), [bridge]);
  return <IndustryResearchCapability api={api} onClose={onClose} onOpenSettings={onOpenSettings} />;
}

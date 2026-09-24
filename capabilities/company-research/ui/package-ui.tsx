import { useMemo } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { CapabilityBridge, CapabilityUiProps } from "@deepfield/capability-sdk";
import { IndustryResearchCapability } from "./IndustryResearchCapability.js";

/** Package-owned bridge adapter; the host validates and authorizes every operation. */
export function createCompanyResearchApi(bridge: CapabilityBridge): DesktopApi {
  const methods = {
    researchDraft: ["get", "invalidate", "update", "submit"],
    industryResearch: ["getCompanyProfileProgress", "subscribeCompanyProfileProgress", "createItem", "updateItem", "deleteItem", "deleteItems", "listItems", "getItem", "listCompanies", "updateCompany", "addCompany", "addCompanies", "removeCompany", "removeCompanies", "recognizeCompanies", "retryCompanyProfile", "confirmCompanyProfileIdentity", "subscribeCompanyProfiles"],
    companyResearch: ["start", "cancel", "getState", "listRuns", "getRun", "exportWord", "retryStructuring", "retryFailed", "deleteRun", "subscribe"],
    companyResearchBatch: ["start", "getState", "cancel", "cancelEntry", "resume", "subscribe"],
    settings: ["get"],
  } as const;
  return Object.fromEntries(Object.entries(methods).map(([namespace, names]) => [namespace, Object.fromEntries(names.map(method => {
      const operation = `${namespace}.${method}`;
      if (method.startsWith("subscribe")) return [method, (listener: (event: unknown) => void) => bridge.subscribe(event => {
        if (event.capabilityId === "company-research" && event.topic === operation) listener(event.payload);
      })];
      return [method, (...input: unknown[]) => bridge.invoke({ capabilityId: "company-research", operation, requestId: crypto.randomUUID(), input })];
  }))])) as unknown as DesktopApi;
}

export function View({ bridge, onClose, onOpenSettings, navigation, interactionEditor, active = true }: CapabilityUiProps) {
  const api = useMemo(() => createCompanyResearchApi(bridge), [bridge]);
  return <IndustryResearchCapability api={api} active={active} onClose={onClose} onOpenSettings={onOpenSettings} {...(navigation ? { navigation } : {})} {...(interactionEditor ? { interactionEditor } : {})} />;
}

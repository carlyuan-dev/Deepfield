import type { CapabilitySnapshot } from "@deepfield/contracts";
import type { CapabilityModuleLoader } from "./CapabilityHost.js";
import { View } from "../../../../../capabilities/company-research/ui/package-ui.js";
export const companySnapshot: CapabilitySnapshot = { packages: [{ id: "company-research", name: "公司研究", description: "研究主题与公司", version: "1.0.0", status: "ready", enabledNextStart: true, navigation: { title: "研究主题", order: 10, route: "/research" }, uiEntry: "deepfield-capability://company-research/dist/ui.js" }], issues: [] };
export const loadCompanyFixture: CapabilityModuleLoader = async () => ({ createView: () => View });
export function companyManagementFixture() {
  let snapshot = structuredClone(companySnapshot);
  const listeners = new Set<(snapshot: CapabilitySnapshot) => void>();
  return {
    list: async () => snapshot,
    subscribe: (listener: (snapshot: CapabilitySnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled: async (_id: string, enabled: boolean) => { snapshot = { ...snapshot, packages: snapshot.packages.map(item => ({ ...item, enabledNextStart: enabled })) }; for (const listener of listeners) listener(snapshot); },
    publish: (next: CapabilitySnapshot) => { snapshot = next; for (const listener of listeners) listener(snapshot); },
  };
}

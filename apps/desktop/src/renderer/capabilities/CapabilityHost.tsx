import { useEffect, useMemo } from "react";
import type { CapabilityUiModule, CapabilityUiProps } from "@deepfield/capability-sdk";
import { capabilityUiRuntime } from "./ui-runtime.js";

export interface CapabilityHostProps extends CapabilityUiProps {
  capabilityId: string;
  module: CapabilityUiModule;
  /** URLs come from the ready snapshot's controlled resource service. */
  cssUrls: readonly string[];
}

export function CapabilityHost({ capabilityId, module, cssUrls, ...props }: CapabilityHostProps) {
  const View = useMemo(() => module.createView(capabilityUiRuntime), [module]);
  const stylesKey = JSON.stringify(cssUrls);
  useEffect(() => {
    const links = (JSON.parse(stylesKey) as string[]).map(href => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.capabilityStyle = capabilityId;
      document.head.append(link);
      return link;
    });
    return () => { for (const link of links) link.remove(); };
  }, [capabilityId, stylesKey]);
  return <div data-capability-ui={capabilityId}><View {...props} /></div>;
}

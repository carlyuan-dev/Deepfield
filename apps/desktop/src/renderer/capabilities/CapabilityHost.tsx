import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CapabilityUiModule, CapabilityUiProps } from "@deepfield/capability-sdk";
import { capabilityUiRuntime } from "./ui-runtime.js";
import type { CapabilityInteractionState } from "./interaction-state.js";

export type CapabilityModuleLoader = (url: string) => Promise<CapabilityUiModule>;
export const loadCapabilityModule: CapabilityModuleLoader = url => import(/* @vite-ignore */ url);
export interface CapabilityHostProps extends CapabilityUiProps {
  capabilityId: string;
  uiEntry: string;
  loadModule?: CapabilityModuleLoader;
  interaction?: CapabilityInteractionState;
}

class PackageBoundary extends Component<{ children: ReactNode; onClose(): void; onFailure(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? <Failure onClose={this.props.onClose} /> : this.props.children; }
}
function Failure({ onClose }: { onClose(): void }) {
  return <div role="alert"><p>能力界面不可用 · ui_load_failed</p><button onClick={onClose}>返回 Chat</button></div>;
}

export function CapabilityHost(props: CapabilityHostProps) {
  return <PackageBoundary key={`${props.capabilityId}:${props.uiEntry}`} onClose={props.onClose} onFailure={() => props.interaction?.fail(props.capabilityId)}><LoadedCapability {...props} /></PackageBoundary>;
}
function LoadedCapability({ capabilityId, uiEntry, loadModule = loadCapabilityModule, interaction, ...props }: CapabilityHostProps) {
  const [View, setView] = useState<React.ComponentType<CapabilityUiProps>>();
  const [failed, setFailed] = useState(false);
  const navigation = useMemo(() => interaction ? { register: (handler: Parameters<CapabilityInteractionState["register"]>[1]) => interaction.register(capabilityId, handler) } : undefined, [interaction, capabilityId]);
  useEffect(() => {
    interaction?.mount(capabilityId);
    let alive = true;
    const links: HTMLLinkElement[] = [];
    const clear = () => { for (const link of links) link.remove(); };
    void (async () => {
      try {
        const base = new URL(uiEntry);
        if (base.protocol !== "deepfield-capability:" || base.hostname !== capabilityId || base.search || base.hash) throw new Error();
        const module = await loadModule(uiEntry);
        if (!alive) return;
        if (typeof module.createView !== "function") throw new Error();
        const cssPaths = module.cssPaths ?? [];
        if (!Array.isArray(cssPaths) || cssPaths.length > 32) throw new Error();
        const urls = cssPaths.map(path => {
          if (typeof path !== "string" || !/^[a-zA-Z0-9_./-]+\.css$/.test(path) || path.startsWith("/") || path.split("/").includes("..")) throw new Error();
          return new URL(path, base).href;
        });
        const view = module.createView(capabilityUiRuntime);
        await Promise.all(urls.map(href => new Promise<void>((resolve, reject) => {
          const link = document.createElement("link");
          link.rel = "stylesheet"; link.href = href; link.dataset.capabilityStyle = capabilityId;
          link.onload = () => resolve(); link.onerror = () => reject(new Error());
          links.push(link); document.head.append(link);
        })));
        if (alive) setView(() => view);
      } catch { clear(); if (alive) { setFailed(true); interaction?.fail(capabilityId); } }
    })();
    return () => { alive = false; clear(); interaction?.unmount(capabilityId); };
  }, [capabilityId, uiEntry, loadModule, interaction]);
  if (failed) return <Failure onClose={props.onClose} />;
  return <div data-capability-ui={capabilityId}>{View ? <><View {...props} {...(navigation ? { navigation } : {})} /><Ready capabilityId={capabilityId} interaction={interaction} /></> : <p>加载能力界面…</p>}</div>;
}
function Ready({ capabilityId, interaction }: { capabilityId: string; interaction: CapabilityInteractionState | undefined }) {
  useEffect(() => { interaction?.ready(capabilityId); }, [capabilityId, interaction]);
  return null;
}

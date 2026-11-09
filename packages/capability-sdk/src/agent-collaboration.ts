import type { AgentCoordinator } from "@deepfield/base/agent/collaboration";
import type { AgentCoordinatorOptions } from "@deepfield/base/agent/collaboration/runtime";
import type { CapabilityHostServices } from "./services.js";

/** The host binds package ownership. Execution adapters stay inside the trusted package. */
export interface CapabilityAgentCollaboration {
  readonly version: 1;
  create(options: Omit<AgentCoordinatorOptions, "owner" | "scopeId" | "resumeFromHandoff"> & { taskScopeId: string }): AgentCoordinator;
}

export function getCapabilityAgentCollaboration(services: CapabilityHostServices | undefined): CapabilityAgentCollaboration | undefined {
  if (!services?.has("agent.collaboration.v1")) return undefined;
  const port = services.get<CapabilityAgentCollaboration>("agent.collaboration.v1");
  if (port?.version !== 1 || typeof port.create !== "function") throw new Error("incompatible_agent_collaboration");
  return port;
}

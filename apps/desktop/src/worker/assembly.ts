import type { PiRuntime, SkillCatalogProvider } from "./agent/pi-chat-agent.js";
import type { WorkerEndpoint, WorkerLoop } from "./message-loop.js";
import { createWorkerMessageLoop } from "./message-loop.js";
import { createFakeChatAgent } from "./chat/fake-chat-agent.js";
import { createPiChatAgent } from "./agent/pi-chat-agent.js";
import { selectChatAgent } from "./chat/select-chat-agent.js";
import {
  createHostConversationReader,
  RemoteToolAuditSink,
  type HostClient,
} from "./host-client.js";
import { createToolRuntime, type UtilityToolRuntime } from "./tools/tool-runtime.js";
import { loadPiSkillCatalog, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import { createCapabilityHostServices } from "@deepfield/capability-sdk";
import { createSnapshotWorkerLoader, type TrustedCapabilityEntry } from "../shared/capability-entry.js";
import { createCapabilityAgentRuntime } from "./capabilities/agent-runtime.js";
import { WorkerCapabilityRegistry, type CapabilityWorkerLoader } from "./capabilities/registry.js";
import { withUsageContext } from "../shared/usage-collection.js";

export interface UtilityAssemblyDeps {
  capabilityLoader?: CapabilityWorkerLoader;
  capabilitySnapshot?: readonly TrustedCapabilityEntry[];
  flushUsage?: () => Promise<void>;
  endpoint: WorkerEndpoint;
  agentMode: string | undefined;
  hostClient: HostClient;
  /** Injectable Pi runtime for tests; production uses the default. */
  piRuntime?: PiRuntime;
  /** Skills directory passed from Main; absent in tests and fake mode. */
  skillsDir?: string;
  /** dev/test/opt-in only: register the offline echo_probe tool. */
  registerProbe?: boolean;
}

export interface UtilityAssembly {
  loop: WorkerLoop;
  toolRuntime: UtilityToolRuntime;
  capabilities: WorkerCapabilityRegistry;
}

function cachedSkillCatalogProvider(skillsDir: string): SkillCatalogProvider {
  let cached: Promise<PiSkillCatalog> | undefined;
  return {
    get() {
      cached ??= loadPiSkillCatalog(skillsDir).then((result) => result.catalog);
      return cached;
    },
  };
}

/**
 * Production Utility assembly: ordinary Pi Chat receives an actor-scoped tool
 * session for each request. Direct tool.run traffic and Pi calls share the
 * same registry, policy, budget and audit pipeline.
 */
export function createUtilityAssembly(deps: UtilityAssemblyDeps): UtilityAssembly {
  const toolRuntime = createToolRuntime({
    audit: new RemoteToolAuditSink(deps.hostClient),
    conversationReader: createHostConversationReader(deps.hostClient),
    registerProbe: deps.registerProbe === true,
  });
  const skills =
    deps.skillsDir !== undefined ? cachedSkillCatalogProvider(deps.skillsDir) : undefined;
  const agent = selectChatAgent(deps.agentMode, {
    fake: () => createFakeChatAgent(),
    pi: () =>
      createPiChatAgent(deps.piRuntime, [], skills, {}, toolRuntime),
  });
  const services = createCapabilityHostServices({
    "model.execution": { runtime: createCapabilityAgentRuntime({ ...(deps.piRuntime ? { runtime: deps.piRuntime } : {}), toolSessions: toolRuntime }), ...(deps.agentMode ? { mode: deps.agentMode } : {}) },
    "tools.retrieval": toolRuntime, "usage.context": withUsageContext,
  });
  const capabilities = new WorkerCapabilityRegistry(value => deps.endpoint.postMessage(value),
    deps.capabilityLoader ?? createSnapshotWorkerLoader(deps.capabilitySnapshot ?? [], services));
  const loop = createWorkerMessageLoop(deps.endpoint, agent, {
    ...(deps.flushUsage ? { flushUsage: deps.flushUsage } : {}),
    toolRuntime,
    capabilities,
    hostReplyHandler: (reply) => deps.hostClient.handleReply(reply),
    onDispose: () => deps.hostClient.dispose(),
  });
  return { loop, toolRuntime, capabilities };
}

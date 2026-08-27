import type { PiRuntime } from "./pi-chat-agent.js";
import type { WorkerEndpoint, WorkerLoop } from "./message-loop.js";
import { createWorkerMessageLoop } from "./message-loop.js";
import { createFakeChatAgent } from "./fake-chat-agent.js";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { selectChatAgent } from "./select-chat-agent.js";
import { RemoteToolAuditSink, type HostClient } from "./host-client.js";
import { createToolRuntime, type UtilityToolRuntime } from "./tool-runtime.js";

export interface UtilityAssemblyDeps {
  endpoint: WorkerEndpoint;
  agentMode: string | undefined;
  hostClient: HostClient;
  /** Injectable Pi runtime for tests; production uses the default. */
  piRuntime?: PiRuntime;
  /** dev/test/opt-in only: register the offline echo_probe tool. */
  registerProbe?: boolean;
}

export interface UtilityAssembly {
  loop: WorkerLoop;
  toolRuntime: UtilityToolRuntime;
}

/**
 * Production Utility assembly: normal Pi Chat always keeps tools: [] (P1
 * behavior). The tool runtime exists for explicit direct tool.run traffic and
 * for opt-in Capability/dev assemblies that call createAgentTools with a
 * trusted per-call trace context.
 */
export function createUtilityAssembly(deps: UtilityAssemblyDeps): UtilityAssembly {
  const toolRuntime = createToolRuntime({
    audit: new RemoteToolAuditSink(deps.hostClient),
    registerProbe: deps.registerProbe === true,
  });
  const agent = selectChatAgent(deps.agentMode, {
    fake: () => createFakeChatAgent(),
    pi: () => createPiChatAgent(deps.piRuntime),
  });
  const loop = createWorkerMessageLoop(deps.endpoint, agent, {
    toolRuntime,
    hostReplyHandler: (reply) => deps.hostClient.handleReply(reply),
    onDispose: () => deps.hostClient.dispose(),
  });
  return { loop, toolRuntime };
}

import type { PiRuntime, SkillCatalogProvider } from "./pi-chat-agent.js";
import type { WorkerEndpoint, WorkerLoop } from "./message-loop.js";
import { createWorkerMessageLoop } from "./message-loop.js";
import { createFakeChatAgent } from "./fake-chat-agent.js";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { selectChatAgent } from "./select-chat-agent.js";
import {
  createHostConversationReader,
  RemoteToolAuditSink,
  type HostClient,
} from "./host-client.js";
import { createToolRuntime, type UtilityToolRuntime } from "./tool-runtime.js";
import { loadPiSkillCatalog, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import {
  createDeepSeekWebSearchAgent,
  routeWebSearchChatAgent,
} from "./deepseek-web-search-agent.js";
import { createCompanyResearchAgent } from "./company-research-agent.js";
import type { ResearchAgent } from "./message-loop.js";

const fakeCompanyResearchAgent: ResearchAgent = {
  async run(request, emit, signal) {
    const identity = { requestId: request.requestId, runId: request.runId };
    emit({ ...identity, type: "started" });
    if (signal.aborted) {
      emit({ ...identity, type: "cancelled" });
      return;
    }
    const text = "Fake 公司调研报告\n来源：https://example.com/deepfield-research";
    emit({ ...identity, type: "text_delta", delta: text });
    emit({ ...identity, type: "completed", text });
  },
};

export interface UtilityAssemblyDeps {
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
      routeWebSearchChatAgent(
        createPiChatAgent(deps.piRuntime, [], skills, {}, toolRuntime),
        createDeepSeekWebSearchAgent(skills === undefined ? {} : { skills }),
      ),
  });
  const loop = createWorkerMessageLoop(deps.endpoint, agent, {
    toolRuntime,
    researchAgent: deps.agentMode === "fake"
      ? fakeCompanyResearchAgent
      : createCompanyResearchAgent(),
    hostReplyHandler: (reply) => deps.hostClient.handleReply(reply),
    onDispose: () => deps.hostClient.dispose(),
  });
  return { loop, toolRuntime };
}

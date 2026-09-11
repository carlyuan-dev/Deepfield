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
import { createCompanyResearchAgent } from "./company-research-agent.js";
import type { ResearchAgent } from "./message-loop.js";

const fakeCompanyResearchAgent: ResearchAgent = {
  async run(request, emit, signal) {
    const identity = { requestId: request.requestId, runId: request.runId, stage: request.stage };
    emit({ ...identity, type: "started" });
    if (signal.aborted) {
      emit({ ...identity, type: "cancelled" });
      return;
    }
    // Offline fixture follows the real stage contracts and the empty-evidence
    // Harness invariant. It never invents sources when structuring a report.
    const text = request.stage === "raw"
      ? [
        "# 公司关键调研原始报告",
        "", "## 调研任务", "Fake 公司调研报告（离线测试）",
        `研究主题：${request.context.topicName}`,
        `目标公司：${request.context.companyName}`,
        `研究方向：${request.template.title}`,
        `具体研究范围：${request.context.focusScope || "未填写"}`,
        `调研截止日期：${request.context.asOfDate}`,
        ...request.template.sections.map((section, index) => [
          "", `## ${index + 1}. ${section.title} \`${section.sectionId}\``,
          "", "### 关键事实", "暂未找到可靠公开信息。",
          "", "### 模块缺口", "缺少可靠公开信息。",
        ].join("\n")),
        "", "## 信息冲突", "未发现影响核心判断的未解决冲突。",
        "", "## 未找到或明确未披露的信息", "五个模块均暂未找到，不表示事实不存在或明确未披露。",
      ].join("\n")
      : JSON.stringify({
        coreSummary: ["现有公开信息不足以形成可靠的核心判断。"],
        sections: request.template.sections.map((section) => ({
          sectionId: section.sectionId, status: "not_found", summary: null, facts: [],
        })),
      });
    if (request.stage === "raw") emit({ ...identity, stage: "raw", type: "text_delta", delta: text });
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
      createPiChatAgent(deps.piRuntime, [], skills, {}, toolRuntime),
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

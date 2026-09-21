import type { CapabilityWorkerRegistrar } from "@deepfield/capability-sdk";
import { CompanyResearchWorkerRequestSchema, CompanyResearchWorkerEventSchema, CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema } from "./contracts/index.js";
import { createCompanyResearchAgent, type CompanyResearchAgent } from "./runtime/company-research-agent.js";
import { createCompanyProfileAgent } from "./runtime/company-profile-agent.js";
import type { CompanyAgentRuntime } from "./runtime/ports.js";

const fakeCompanyResearchAgent: CompanyResearchAgent = {
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


export interface CompanyResearchWorkerPorts {
  runtime: CompanyAgentRuntime;
  mode?: string;
  withUsage<T>(context: { sourceId: string; taskId: string; operationId?: string; stageId?: string }, work: () => T): T;
}
export function activate(registrar: CapabilityWorkerRegistrar, ports: CompanyResearchWorkerPorts): void {
  const research = ports.mode === "fake" ? fakeCompanyResearchAgent : createCompanyResearchAgent({ runtime: ports.runtime });
  const profile = createCompanyProfileAgent({ runtime: ports.runtime });
  registrar.register("research", CompanyResearchWorkerRequestSchema, CompanyResearchWorkerEventSchema, async (request, emit, signal) => {
    await ports.withUsage({ sourceId: `company-research-${request.stage}`, taskId: request.requestId, operationId: request.runId, stageId: request.stage }, () =>
      research.run(request, event => {
        if (event.requestId !== request.requestId || event.runId !== request.runId || event.stage !== request.stage) throw new Error("invalid_correlation");
        emit(event, event.type === "completed" || event.type === "failed" || event.type === "cancelled" ? event.type : undefined);
      }, signal));
  });
  registrar.register("profile", CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema, async (request, emit, signal) => {
    if (ports.mode === "fake") { emit({ kind: "company-profile.event", requestId: request.requestId, companyId: request.companyId, type: "failed", code: "search_unavailable" }, "failed"); return; }
    await ports.withUsage({ sourceId: "company-profile", taskId: request.requestId }, () =>
      profile.run(request, event => {
        if (event.requestId !== request.requestId || event.companyId !== request.companyId) throw new Error("invalid_correlation");
        emit(event, event.type === "diagnostic" ? undefined : event.type);
      }, signal));
  });
}

import {
  getCompanyResearchTemplate, STRUCTURED_RESEARCH_OUTPUT_SCHEMA,
  type CompanyResearchRawWorkerRequest, type CompanyResearchStructureWorkerRequest,
} from "@deepfield/contracts";

export function rawResearchRequest(): CompanyResearchRawWorkerRequest {
  return {
    requestId: "research-1", runId: "run-1", kind: "company-research.raw.run", stage: "raw",
    llm: { id: "llm-1", name: "Test", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128000, apiKey: "sk-secret-research-key" },
    search: { id: "search-1", name: "Search", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: { searchEngine: "search_std" }, apiKey: "search-key" },
    toolAccess: { network: "enabled", maxAgentTurns: 12, maxSearchCalls: 8, maxFetchCalls: 8 },
    context: {
      currentDate: "2026-09-11", companyName: "Unitree Robotics",
      legalName: "Hangzhou Yushu Technology Co., Ltd.", aliases: ["Unitree"],
      headquarters: "Hangzhou, China", foundedAt: "2016",
      officialWebsite: "https://www.unitree.com", stockListings: [],
      businessTags: ["Robotics", "Embodied AI"],
      topicName: "Humanoid Robotics", topicScope: "Commercialization and core components",
      companyNote: "Candidate note for this topic only",
      direction: "product_and_technology", focusScope: "Humanoid actuators", asOfDate: "2026-06-30",
    },
    template: getCompanyResearchTemplate("product_and_technology"),
  };
}

export function structureResearchRequest(): CompanyResearchStructureWorkerRequest {
  const { search: _search, ...raw } = rawResearchRequest();
  return {
    ...raw, requestId: "structure-1", kind: "company-research.structure.run", stage: "structure",
    toolAccess: { network: "disabled", maxAgentTurns: 1, maxSearchCalls: 0, maxFetchCalls: 0 },
    rawReportText: "# 原始报告\n产品已发布。[公司公告](https://example.com/report)",
    outputSchema: STRUCTURED_RESEARCH_OUTPUT_SCHEMA,
  };
}

export function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

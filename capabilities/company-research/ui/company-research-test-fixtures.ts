import { getCompanyResearchTemplate, type KeyResearchRun, type ResearchRun, type ResearchRunSummary, type CompanyResearchState } from "../contracts/index.js";

export function researchRun(overrides: Partial<KeyResearchRun> = {}): KeyResearchRun {
  const template = getCompanyResearchTemplate("product_and_technology");
  const run: KeyResearchRun = {
    id: "run-1" as KeyResearchRun["id"], itemId: "item-research" as KeyResearchRun["itemId"],
    companyId: "company-research" as KeyResearchRun["companyId"],
    schemaVersion: "company-research-report-v1", status: "completed",
    direction: "product_and_technology", focusScope: "关注新品", asOfDate: "2026-09-09",
    researchContext: { companyName: "小米", topicName: "智能眼镜", currentDate: "2026-09-09", direction: "product_and_technology", asOfDate: "2026-09-09" },
    template, harnessVersion: 1, structuringAttempts: 1,
    createdAt: "2026-09-09T08:00:00.000Z", completedAt: "2026-09-09T08:30:00.000Z",
    rawReportText: "公司关键调研原始报告\n原始事实 https://example.com/one",
    rawCompletedAt: "2026-09-09T08:20:00.000Z",
    structuredContent: {
      coreSummary: ["新品已发布"],
      sections: template.sections.map((section, index) => ({
        sectionId: section.sectionId, status: (["found", "partial", "not_found", "not_disclosed", "conflicting"] as const)[index]!,
        summary: null, facts: index === 0 ? [{ text: "设备已经发布", timeContext: "2026年", claimType: "reported_fact", source: { title: "发布来源", url: "https://example.com/one" } }] : [],
      })),
    },
    ...overrides,
  };
  if (run.status !== "completed") {
    delete run.structuredContent;
    delete run.completedAt;
  }
  if (run.status === "researching" || run.status === "research_failed") {
    delete run.rawReportText;
    delete run.rawCompletedAt;
    run.structuringAttempts = 0;
  }
  if (run.status === "researching") delete run.lastFailureCode;
  return run;
}

export function researchSummary(run: ResearchRun): ResearchRunSummary {
  if (run.schemaVersion === "legacy-freeform-v1") {
    const { reportText: _body, ...summary } = run;
    return summary;
  }
  const { rawReportText: _raw, structuredContent: _content, researchContext: _context, template: _template, harnessVersion: _version, ...summary } = run;
  if (summary.status !== "completed" && summary.status !== "research_failed" && summary.status !== "structure_failed") throw new Error("history only");
  return { ...summary, status: summary.status };
}

export function activeResearch(run: KeyResearchRun, draftText = ""): CompanyResearchState {
  if (run.status !== "researching" && run.status !== "structuring") throw new Error("active only");
  const { rawReportText: _raw, structuredContent: _content, researchContext: _context, template: _template, harnessVersion: _version, ...summary } = run;
  return { runs: [], globalActiveRun: { runId: run.id, itemId: run.itemId, companyId: run.companyId, stage: run.status === "researching" ? "raw" : "structure" }, active: { run: { ...summary, status: run.status }, draftText } };
}

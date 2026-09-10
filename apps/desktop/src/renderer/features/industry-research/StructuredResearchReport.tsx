import { RESEARCH_SECTION_STATUS_LABELS, type KeyResearchRun, type ResearchClaimType } from "@deepfield/contracts";

const CLAIM_LABELS: Record<ResearchClaimType, string> = {
  reported_fact: "已报道事实", company_statement: "公司声明", plan: "计划", estimate: "估计", forecast: "预测",
};
function safeSource(url: string): boolean {
  try { return ["http:", "https:"].includes(new URL(url).protocol); }
  catch { return false; }
}
export function StructuredResearchReport({ run }: { run: KeyResearchRun }) {
  const content = run.structuredContent;
  if (!content) return <p role="alert">结构化报告暂不可用，请重新加载。</p>;
  return <div className="structured-research-report">
    <section><h3>核心结论</h3><ul>{content.coreSummary.map((text, index) => <li key={index}>{text}</li>)}</ul></section>
    {run.template.sections.map((template) => {
      const section = content.sections.find((entry) => entry.sectionId === template.sectionId);
      return <section className="research-section-card" key={template.sectionId}>
        <div className="research-section-heading"><h3>{template.title}</h3>{section && <span className="research-badge">{RESEARCH_SECTION_STATUS_LABELS[section.status]}</span>}</div>
        {section?.summary && <p>{section.summary}</p>}
        {!section && <p role="alert">本节内容暂不可用。</p>}
        {section && section.facts.length > 0 && <ul className="research-facts">{section.facts.map((fact, index) => <li key={index}>
          <p>{fact.text}</p>
          <div className="research-fact-meta">
            {fact.timeContext && <span>{fact.timeContext}</span>}
            <span className="research-badge">{CLAIM_LABELS[fact.claimType]}</span>
            {safeSource(fact.source.url) ? <a href={fact.source.url} target="_blank" rel="noopener noreferrer">{fact.source.title}</a> : <span><span>{fact.source.title}</span>（来源链接不可用）</span>}
          </div>
        </li>)}</ul>}
      </section>;
    })}
  </div>;
}

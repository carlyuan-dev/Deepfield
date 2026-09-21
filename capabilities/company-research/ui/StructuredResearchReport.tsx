import { RESEARCH_SECTION_STATUS_LABELS, type KeyResearchRun } from "../contracts/index.js";
import { isSafeHttpUrl, UrlPopoverLink } from "../../../apps/desktop/src/renderer/components/UrlPopoverLink.js";

export function StructuredResearchReport({ run }: { run: KeyResearchRun }) {
  const content = run.structuredContent;
  if (!content) return <p role="alert">结构化报告暂不可用，请重新加载。</p>;
  return <div className="structured-research-report">
    <section><h3>核心结论</h3><ul>{content.coreSummary.map((text, index) => <li key={index}>{text}</li>)}</ul></section>
    {run.template.sections.map((template) => {
      const section = content.sections.find((entry) => entry.sectionId === template.sectionId);
      return <section className="research-section-card" key={template.sectionId}>
        <div className="research-section-heading"><h3>{template.title}</h3>{section && section.status !== "found" && section.status !== "partial" && <span className="research-badge">{RESEARCH_SECTION_STATUS_LABELS[section.status]}</span>}</div>
        {section?.summary && <p>{section.summary}</p>}
        {!section && <p role="alert">本节内容暂不可用。</p>}
        {section && section.facts.length > 0 && <ul className="research-facts">{section.facts.map((fact, index) => <li key={index}>
          <p>{fact.text}</p>
          <div className="research-fact-meta">
            {isSafeHttpUrl(fact.source.url)
              ? <UrlPopoverLink href={fact.source.url}>{fact.source.title}</UrlPopoverLink>
              : <span><span>{fact.source.title}</span>（来源链接不可用）</span>}
          </div>
        </li>)}</ul>}
      </section>;
    })}
  </div>;
}

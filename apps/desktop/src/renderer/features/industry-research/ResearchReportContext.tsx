import type { KeyResearchRun } from "@deepfield/contracts";

/** Both report views identify the saved run, independent of today's target profile. */
export function ResearchReportContext({ run }: { run: KeyResearchRun }) {
  const context = run.researchContext;
  return <section aria-label="报告研究背景">
    <h3>研究背景</h3>
    <dl className="research-context">
      <div><dt>研究主题</dt><dd>{context.topicName}</dd></div>
      <div><dt>研究方向</dt><dd>{run.template.title}</dd></div>
      <div><dt>重点研究范围</dt><dd>{run.focusScope || "未限定"}</dd></div>
      <div><dt>截止日期</dt><dd>{run.asOfDate}</dd></div>
    </dl>
  </section>;
}

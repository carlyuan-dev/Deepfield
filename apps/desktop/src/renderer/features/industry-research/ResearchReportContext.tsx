import type { KeyResearchRun } from "@deepfield/contracts";
import { LinkifiedText } from "../../components/LinkifiedText.js";

/** Both report views identify the saved run, independent of today's target profile. */
export function ResearchReportContext({ run }: { run: KeyResearchRun }) {
  const context = run.researchContext;
  return <section aria-label="报告研究背景">
    <h3>研究背景</h3>
    <dl className="research-context">
      <div><dt>公司</dt><dd>{context.companyName}</dd></div>
      {context.legalName && <div><dt>公司全称</dt><dd>{context.legalName}</dd></div>}
      {context.aliases?.length ? <div><dt>别名</dt><dd>{context.aliases.join("、")}</dd></div> : null}
      {context.headquarters && <div><dt>总部</dt><dd>{context.headquarters}</dd></div>}
      {context.foundedAt && <div><dt>成立日期</dt><dd>{context.foundedAt}</dd></div>}
      {context.officialWebsite && <div><dt>官网</dt><dd><LinkifiedText text={context.officialWebsite} /></dd></div>}
      {context.stockListings?.length ? <div><dt>上市信息</dt><dd>{context.stockListings.map((listing) => `${listing.exchange} ${listing.ticker}`).join("、")}</dd></div> : null}
      {context.businessTags?.length ? <div><dt>业务标签</dt><dd>{context.businessTags.join("、")}</dd></div> : null}
      <div><dt>研究主题</dt><dd>{context.topicName}</dd></div>
      {context.topicScope && <div><dt>主题范围</dt><dd>{context.topicScope}</dd></div>}
      {context.companyNote && <div><dt>公司备注</dt><dd>{context.companyNote}</dd></div>}
      <div><dt>研究方向</dt><dd>{run.template.title}</dd></div>
      <div><dt>本次具体研究范围</dt><dd>{run.focusScope || "未限定"}</dd></div>
      <div><dt>截至日期</dt><dd>{run.asOfDate}</dd></div>
    </dl>
  </section>;
}
